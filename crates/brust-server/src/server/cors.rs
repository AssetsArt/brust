//! CORS header resolution + assembly.
//!
//! [`ResolvedCors`] is built ONCE from the boot-time [`CorsConfig`] (see
//! `server::start`, mirroring the `powered_by` resolution) so the hot path
//! clones prebuilt `HeaderValue`s instead of re-joining/parsing strings per
//! request. Two assembly paths consume it:
//!
//! 1. **Preflight** (`preflight_response`): a full 204 answered in Rust before
//!    the method gate — never reaches the worker/render pipeline.
//! 2. **Actual-response stamping** (`stamp_response`): applied at the
//!    `service_fn` closure ONLY — the single chokepoint that sees every
//!    response path. NEVER stamp inside `response_from_meta` /
//!    `chunked_response_from_meta` / dispatch: the L1 cache captures framed
//!    bytes there, so stamping a per-request echoed Origin would bake it into a
//!    SHARED cache entry (cross-origin cache poisoning).

use http::header::{
    ACCESS_CONTROL_ALLOW_CREDENTIALS, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_MAX_AGE,
    ACCESS_CONTROL_REQUEST_HEADERS, VARY,
};
use http::{HeaderMap, HeaderValue, Response, StatusCode};
use tracing::warn;

use crate::config::CorsConfig;
use crate::server::body::{self, ResponseBody, empty_body};

/// Default preflight `Access-Control-Allow-Methods` when the config omits it.
const DEFAULT_METHODS: &str = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
/// Default preflight `Access-Control-Max-Age` (seconds) when the config omits it.
const DEFAULT_MAX_AGE_SECONDS: u32 = 600;

/// Boot-resolved CORS policy: prebuilt `HeaderValue`s, resolved once before the
/// accept loop.
pub(crate) struct ResolvedCors {
    /// Exact allowed origins (scheme+host+port). Ignored when `wildcard`.
    origins: Vec<String>,
    /// True when the configured list contained `"*"`: every origin is allowed
    /// and `Access-Control-Allow-Origin` is the literal `*`. With a wildcard
    /// the response does not vary by Origin, so no `Vary: Origin` is appended.
    /// (`credentials + wildcard` is rejected at boot, so wildcard ⇒ no
    /// credentials.)
    wildcard: bool,
    allow_methods: HeaderValue,
    /// `None` → echo the request's `Access-Control-Request-Headers`.
    allow_headers: Option<HeaderValue>,
    /// `None` → header not emitted.
    expose_headers: Option<HeaderValue>,
    credentials: bool,
    max_age: HeaderValue,
}

impl ResolvedCors {
    /// Resolve the boot config into prebuilt header values. A configured list
    /// whose joined value is not a valid `HeaderValue` falls back to the
    /// framework default with a warning (mirror of the `powered_by`
    /// warn-don't-drop posture) — unreachable for sane configs, but a relaxed
    /// future validator must surface the mistake, not silently change policy.
    pub(crate) fn from_config(cfg: &CorsConfig) -> Self {
        let join = |list: &Option<Vec<String>>, label: &str| -> Option<HeaderValue> {
            let list = list.as_ref().filter(|l| !l.is_empty())?;
            let joined = list.join(",");
            match HeaderValue::from_str(&joined) {
                Ok(v) => Some(v),
                Err(e) => {
                    warn!(value = %joined, error = %e, "cors.{label} rejected by HeaderValue — using default");
                    None
                }
            }
        };
        ResolvedCors {
            origins: cfg.origins.clone(),
            wildcard: cfg.is_wildcard(),
            allow_methods: join(&cfg.methods, "methods")
                .unwrap_or_else(|| HeaderValue::from_static(DEFAULT_METHODS)),
            allow_headers: join(&cfg.headers, "headers"),
            expose_headers: join(&cfg.expose_headers, "exposeHeaders"),
            credentials: cfg.credentials,
            max_age: HeaderValue::from(cfg.max_age_seconds.unwrap_or(DEFAULT_MAX_AGE_SECONDS)),
        }
    }

    /// The `Access-Control-Allow-Origin` value for a request `Origin`, or
    /// `None` when the origin is not allowed: the literal `*` under a wildcard
    /// config, the echoed origin on an exact match.
    pub(crate) fn allow_origin_value(&self, origin: &HeaderValue) -> Option<HeaderValue> {
        if self.wildcard {
            return Some(HeaderValue::from_static("*"));
        }
        let o = origin.to_str().ok()?;
        if self.origins.iter().any(|allowed| allowed == o) {
            Some(origin.clone())
        } else {
            None
        }
    }

    /// Build the preflight 204. `acao` is the value `allow_origin_value`
    /// produced for the request's Origin (the caller has already established
    /// the origin is allowed).
    pub(crate) fn preflight_response(
        &self,
        acao: HeaderValue,
        req_headers: &HeaderMap,
    ) -> Response<ResponseBody> {
        let mut resp = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(empty_body())
            .unwrap_or_else(|_| body::canned_500());
        let h = resp.headers_mut();
        h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, acao);
        h.insert(ACCESS_CONTROL_ALLOW_METHODS, self.allow_methods.clone());
        // Config list, or echo the request's Access-Control-Request-Headers;
        // neither → header omitted (no headers were requested).
        let allow_headers = self
            .allow_headers
            .clone()
            .or_else(|| req_headers.get(ACCESS_CONTROL_REQUEST_HEADERS).cloned());
        if let Some(v) = allow_headers {
            h.insert(ACCESS_CONTROL_ALLOW_HEADERS, v);
        }
        h.insert(ACCESS_CONTROL_MAX_AGE, self.max_age.clone());
        if self.credentials {
            h.insert(
                ACCESS_CONTROL_ALLOW_CREDENTIALS,
                HeaderValue::from_static("true"),
            );
        }
        // The preflight answer varies by all three request inputs.
        h.insert(
            VARY,
            HeaderValue::from_static(
                "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
            ),
        );
        resp
    }

    /// Stamp CORS headers onto an actual response. Called at the `service_fn`
    /// chokepoint ONLY (see module docs — the load-bearing cache-poisoning
    /// invariant).
    ///
    /// - `Access-Control-Allow-Origin` / `-Allow-Credentials` /
    ///   `-Expose-Headers`: insert-if-absent (user middleware wins, the
    ///   X-Powered-By precedent), only when the request's Origin is allowed.
    /// - `Vary: Origin`: APPENDED (comma-joined, deduped — never replaced) on
    ///   EVERY response when the config is non-wildcard, even when the request
    ///   carried no Origin — otherwise an intermediary caches the no-ACAO
    ///   variant and replays it cross-origin.
    pub(crate) fn stamp_response(&self, headers: &mut HeaderMap, origin: Option<&HeaderValue>) {
        if let Some(origin) = origin
            && let Some(acao) = self.allow_origin_value(origin)
        {
            headers.entry(ACCESS_CONTROL_ALLOW_ORIGIN).or_insert(acao);
            if self.credentials {
                headers
                    .entry(ACCESS_CONTROL_ALLOW_CREDENTIALS)
                    .or_insert(HeaderValue::from_static("true"));
            }
            if let Some(v) = &self.expose_headers {
                headers
                    .entry(ACCESS_CONTROL_EXPOSE_HEADERS)
                    .or_insert(v.clone());
            }
        }
        if !self.wildcard {
            append_vary_token(headers, "Origin");
        }
    }
}

/// Append `token` to the response's `Vary` header: comma-join to the existing
/// value(s), NEVER insert-or-replace — `static_asset_response` already emits
/// `Vary: Accept-Encoding`, and an or_insert would silently drop the Origin
/// variance (CDN cache poisoning). No-op when the token (or `*`) is already
/// present, so double-stamping (e.g. the preflight 204 passing back through the
/// service chokepoint) never duplicates.
pub(crate) fn append_vary_token(headers: &mut HeaderMap, token: &str) {
    // Fast path: no existing Vary (the overwhelming majority of responses) —
    // zero allocations on the per-response hot path.
    if !headers.contains_key(VARY) {
        if let Ok(v) = HeaderValue::from_str(token) {
            headers.insert(VARY, v);
        }
        return;
    }

    let mut parts: Vec<String> = Vec::new();
    let mut saw_opaque = false;
    for v in headers.get_all(VARY) {
        let Ok(s) = v.to_str() else {
            // Opaque (non-UTF-8) existing Vary value we can't safely merge
            // into. Keep scanning the REMAINING lines first — a later line may
            // already carry the token or `*` (in which case nothing to add) —
            // and only then append the token as an additional Vary line
            // (RFC-equivalent to the comma-joined form).
            saw_opaque = true;
            continue;
        };
        for existing in s.split(',') {
            let existing = existing.trim();
            if existing.eq_ignore_ascii_case(token) || existing == "*" {
                return; // already varies on the token (or on everything)
            }
            if !existing.is_empty() {
                parts.push(existing.to_string());
            }
        }
    }
    if saw_opaque {
        // Can't rebuild a merged single line without losing the opaque value:
        // append the token as its own Vary line alongside the existing ones.
        if let Ok(t) = HeaderValue::from_str(token) {
            headers.append(VARY, t);
        }
        return;
    }
    parts.push(token.to_string());
    if let Ok(v) = HeaderValue::from_str(&parts.join(", ")) {
        headers.insert(VARY, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(origins: &[&str]) -> CorsConfig {
        CorsConfig {
            origins: origins.iter().map(|s| s.to_string()).collect(),
            methods: None,
            headers: None,
            expose_headers: None,
            credentials: false,
            max_age_seconds: None,
        }
    }

    fn hv(s: &str) -> HeaderValue {
        HeaderValue::from_str(s).unwrap()
    }

    // ----- origin matching -----

    #[test]
    fn origin_exact_match_echoes_origin() {
        let c = ResolvedCors::from_config(&cfg(&["https://a.example", "http://b.test:8080"]));
        assert_eq!(
            c.allow_origin_value(&hv("https://a.example")),
            Some(hv("https://a.example"))
        );
        assert_eq!(
            c.allow_origin_value(&hv("http://b.test:8080")),
            Some(hv("http://b.test:8080"))
        );
    }

    #[test]
    fn origin_miss_is_none() {
        let c = ResolvedCors::from_config(&cfg(&["https://a.example"]));
        assert_eq!(c.allow_origin_value(&hv("https://evil.example")), None);
        // Exact match only: scheme and port matter, no substring matching.
        assert_eq!(c.allow_origin_value(&hv("http://a.example")), None);
        assert_eq!(c.allow_origin_value(&hv("https://a.example:444")), None);
    }

    #[test]
    fn origin_wildcard_allows_all_as_literal_star() {
        let c = ResolvedCors::from_config(&cfg(&["*"]));
        assert_eq!(
            c.allow_origin_value(&hv("https://any.example")),
            Some(hv("*"))
        );
    }

    #[test]
    fn origin_wildcard_in_mixed_list_is_wildcard() {
        // ['*', 'https://x.com'] behaves as wildcard — even an unlisted origin
        // is allowed and gets the literal '*'.
        let c = ResolvedCors::from_config(&cfg(&["https://x.com", "*"]));
        assert_eq!(
            c.allow_origin_value(&hv("https://unlisted.example")),
            Some(hv("*"))
        );
        assert_eq!(c.allow_origin_value(&hv("https://x.com")), Some(hv("*")));
    }

    // ----- preflight assembly -----

    #[test]
    fn preflight_defaults_echo_acrh_and_default_methods_max_age() {
        let c = ResolvedCors::from_config(&cfg(&["https://a.example"]));
        let mut req = HeaderMap::new();
        req.insert(ACCESS_CONTROL_REQUEST_HEADERS, hv("content-type, x-token"));
        let resp = c.preflight_response(hv("https://a.example"), &req);

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let h = resp.headers();
        assert_eq!(
            h.get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://a.example"
        );
        assert_eq!(
            h.get(ACCESS_CONTROL_ALLOW_METHODS).unwrap(),
            "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        );
        // No config headers → echo Access-Control-Request-Headers.
        assert_eq!(
            h.get(ACCESS_CONTROL_ALLOW_HEADERS).unwrap(),
            "content-type, x-token"
        );
        assert_eq!(h.get(ACCESS_CONTROL_MAX_AGE).unwrap(), "600");
        // No credentials configured → header absent.
        assert!(h.get(ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
        assert_eq!(
            h.get(VARY).unwrap(),
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
        );
    }

    #[test]
    fn preflight_configured_lists_credentials_and_max_age() {
        let c = ResolvedCors::from_config(&CorsConfig {
            origins: vec!["https://a.example".to_string()],
            methods: Some(vec!["GET".to_string(), "POST".to_string()]),
            headers: Some(vec!["content-type".to_string(), "x-api-key".to_string()]),
            expose_headers: None,
            credentials: true,
            max_age_seconds: Some(86400),
        });
        let req = HeaderMap::new();
        let resp = c.preflight_response(hv("https://a.example"), &req);
        let h = resp.headers();
        assert_eq!(h.get(ACCESS_CONTROL_ALLOW_METHODS).unwrap(), "GET,POST");
        // Config list wins over (absent) ACRH echo.
        assert_eq!(
            h.get(ACCESS_CONTROL_ALLOW_HEADERS).unwrap(),
            "content-type,x-api-key"
        );
        assert_eq!(h.get(ACCESS_CONTROL_MAX_AGE).unwrap(), "86400");
        assert_eq!(h.get(ACCESS_CONTROL_ALLOW_CREDENTIALS).unwrap(), "true");
    }

    #[test]
    fn preflight_without_acrh_and_without_config_headers_omits_allow_headers() {
        let c = ResolvedCors::from_config(&cfg(&["https://a.example"]));
        let resp = c.preflight_response(hv("https://a.example"), &HeaderMap::new());
        assert!(resp.headers().get(ACCESS_CONTROL_ALLOW_HEADERS).is_none());
    }

    // ----- Vary append semantics -----

    #[test]
    fn vary_append_to_existing_value_comma_joins() {
        let mut h = HeaderMap::new();
        h.insert(VARY, hv("Accept-Encoding"));
        append_vary_token(&mut h, "Origin");
        let all: Vec<_> = h.get_all(VARY).iter().collect();
        assert_eq!(all.len(), 1, "must merge, not add a second line");
        assert_eq!(all[0], "Accept-Encoding, Origin");
    }

    #[test]
    fn vary_append_on_empty_inserts_token() {
        let mut h = HeaderMap::new();
        append_vary_token(&mut h, "Origin");
        assert_eq!(h.get(VARY).unwrap(), "Origin");
    }

    #[test]
    fn vary_append_dedupes_case_insensitively() {
        let mut h = HeaderMap::new();
        h.insert(VARY, hv("origin, Accept-Encoding"));
        append_vary_token(&mut h, "Origin");
        assert_eq!(h.get(VARY).unwrap(), "origin, Accept-Encoding");
    }

    #[test]
    fn vary_append_respects_star() {
        let mut h = HeaderMap::new();
        h.insert(VARY, hv("*"));
        append_vary_token(&mut h, "Origin");
        assert_eq!(h.get(VARY).unwrap(), "*");
    }

    #[test]
    fn vary_append_merges_multiple_existing_lines() {
        let mut h = HeaderMap::new();
        h.append(VARY, hv("Accept-Encoding"));
        h.append(VARY, hv("Accept-Language"));
        append_vary_token(&mut h, "Origin");
        let all: Vec<_> = h.get_all(VARY).iter().collect();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], "Accept-Encoding, Accept-Language, Origin");
    }

    #[test]
    fn vary_append_opaque_line_does_not_mask_later_star() {
        // Regression: an opaque (non-UTF-8) first Vary line must not stop the
        // scan — a later `*` line means "varies on everything", so nothing is
        // appended.
        let mut h = HeaderMap::new();
        h.append(VARY, HeaderValue::from_bytes(&[0xFF]).unwrap());
        h.append(VARY, hv("*"));
        append_vary_token(&mut h, "Origin");
        let all: Vec<_> = h.get_all(VARY).iter().collect();
        assert_eq!(all.len(), 2); // untouched
    }

    #[test]
    fn vary_append_opaque_line_appends_token_as_extra_line() {
        // Opaque value with no `*` anywhere: the token rides as its own Vary
        // line (RFC-equivalent to comma-joining) so variance is never dropped.
        let mut h = HeaderMap::new();
        h.append(VARY, HeaderValue::from_bytes(&[0xFF]).unwrap());
        h.append(VARY, hv("Accept-Encoding"));
        append_vary_token(&mut h, "Origin");
        let all: Vec<_> = h.get_all(VARY).iter().collect();
        assert_eq!(all.len(), 3);
        assert_eq!(all[2], "Origin");
    }

    // ----- response stamping -----

    #[test]
    fn stamp_allowed_origin_sets_acao_credentials_expose_and_vary() {
        let c = ResolvedCors::from_config(&CorsConfig {
            origins: vec!["https://a.example".to_string()],
            methods: None,
            headers: None,
            expose_headers: Some(vec!["x-request-id".to_string()]),
            credentials: true,
            max_age_seconds: None,
        });
        let mut h = HeaderMap::new();
        let origin = hv("https://a.example");
        c.stamp_response(&mut h, Some(&origin));
        assert_eq!(
            h.get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://a.example"
        );
        assert_eq!(h.get(ACCESS_CONTROL_ALLOW_CREDENTIALS).unwrap(), "true");
        assert_eq!(
            h.get(ACCESS_CONTROL_EXPOSE_HEADERS).unwrap(),
            "x-request-id"
        );
        assert_eq!(h.get(VARY).unwrap(), "Origin");
    }

    #[test]
    fn stamp_is_insert_if_absent_user_headers_win() {
        let c = ResolvedCors::from_config(&cfg(&["https://a.example"]));
        let mut h = HeaderMap::new();
        h.insert(
            ACCESS_CONTROL_ALLOW_ORIGIN,
            hv("https://middleware.example"),
        );
        let origin = hv("https://a.example");
        c.stamp_response(&mut h, Some(&origin));
        assert_eq!(
            h.get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://middleware.example"
        );
    }

    #[test]
    fn stamp_disallowed_origin_no_acao_but_vary_still_appended() {
        let c = ResolvedCors::from_config(&cfg(&["https://a.example"]));
        let mut h = HeaderMap::new();
        h.insert(VARY, hv("Accept-Encoding"));
        let origin = hv("https://evil.example");
        c.stamp_response(&mut h, Some(&origin));
        assert!(h.get(ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert_eq!(h.get(VARY).unwrap(), "Accept-Encoding, Origin");
    }

    #[test]
    fn stamp_no_origin_request_still_appends_vary_when_non_wildcard() {
        let c = ResolvedCors::from_config(&cfg(&["https://a.example"]));
        let mut h = HeaderMap::new();
        c.stamp_response(&mut h, None);
        assert!(h.get(ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert_eq!(h.get(VARY).unwrap(), "Origin");
    }

    #[test]
    fn stamp_wildcard_sets_star_and_skips_vary() {
        let c = ResolvedCors::from_config(&cfg(&["*"]));
        let mut h = HeaderMap::new();
        let origin = hv("https://any.example");
        c.stamp_response(&mut h, Some(&origin));
        assert_eq!(h.get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(), "*");
        // Wildcard responses don't vary by Origin.
        assert!(h.get(VARY).is_none());
    }

    #[test]
    fn stamp_preflight_response_again_is_idempotent() {
        // The preflight 204 returns through the same service chokepoint that
        // stamps every response — re-stamping must not duplicate anything.
        let c = ResolvedCors::from_config(&cfg(&["https://a.example"]));
        let origin = hv("https://a.example");
        let mut resp = c.preflight_response(origin.clone(), &HeaderMap::new());
        let before: Vec<(String, String)> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
            .collect();
        c.stamp_response(resp.headers_mut(), Some(&origin));
        let after: Vec<(String, String)> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
            .collect();
        assert_eq!(before, after);
    }
}
