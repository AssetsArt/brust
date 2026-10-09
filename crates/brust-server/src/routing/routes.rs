use std::sync::Arc;

use parking_lot::RwLock;
use serde::Deserialize;
use serde::Serialize;

use crate::cache::key_expr::Expr;
use crate::manifest::{BypassSpec, Manifest, RouteCache};

// Compiled, request-ready cache directives for one route. Parsed once at
// install (errors surface as install failure); evaluated per request.
#[derive(Clone, Default)]
pub struct CompiledCache {
    pub prefix: Option<Expr>,
    /// None = never bypass; Some(None) = always; Some(Some(expr)) = conditional.
    pub bypass: Option<Option<Expr>>,
}

pub(crate) fn serialize_as_map<S, K, V>(vec: &[(K, V)], serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
    K: serde::Serialize,
    V: serde::Serialize,
{
    serializer.collect_map(vec.iter().map(|(k, v)| (k, v)))
}

/// Structured view of the incoming HTTP request, owned by the envelope.
/// Parsed once in Rust (cheaper than re-parsing in JS) and embedded in
/// the JSON envelope handed to the worker.
#[derive(Serialize)]
pub struct RequestEnvelope<'a> {
    pub method: &'a str,
    pub url: &'a str,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub headers: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub cookies: Vec<(&'a str, std::borrow::Cow<'a, str>)>,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub search: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
}

/// The matched route plus the parsed request. v2 has one envelope shape (the
/// 0.1.x action/mcp/sse/ws variants and the `kind` discriminant are gone); its
/// `req` is what a `loader` call receives.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub route_id: u32,
    pub path: &'a str,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub params: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
    pub req: RequestEnvelope<'a>,
}

/// Outcome of a match against the radix tree.
pub enum MatchResult<'a> {
    Matched {
        route_id: u32,
        envelope: RouteEnvelope<'a>,
    },
    /// A catch-all (`path: '*'`) was registered for the best-matching prefix.
    /// The caller should render `route_id` and stamp the response HTTP 404.
    NotFound {
        route_id: u32,
        envelope: RouteEnvelope<'a>,
    },
    NoMatch,
}

#[derive(Debug, Default, Deserialize)]
pub struct RouteConfig {
    pub path: String,
    #[serde(default)]
    pub cache: Option<RouteCache>,
    /// Set `true` by the TS flatten step when the route has `path: '*'`.
    /// When true the route is NOT inserted into matchit; instead it is recorded
    /// in `not_found_table` keyed by `not_found_prefix`. The route_id (array
    /// index) is preserved so both sides can look it up via `byRouteId`.
    #[serde(default, rename = "notFound")]
    pub not_found: bool,
    /// The effective prefix for this catch-all: the parent layout's `fullPath`
    /// (root catch-all → `""`). Longest-prefix match selects it on NoMatch.
    #[serde(default, rename = "notFoundPrefix")]
    pub not_found_prefix: String,
}

#[derive(Default)]
pub struct RouteTable {
    inner: RwLock<matchit::Router<u32>>,
    cache_configs: RwLock<Vec<Option<RouteCache>>>,
    /// Compiled L1 prefix/bypass expressions, parallel to `cache_configs`.
    /// Index = route_id. Parsed once at install; evaluated per request.
    compiled_caches: RwLock<Vec<Arc<CompiledCache>>>,
    /// Post-router fallback tier: catch-all routes sorted by prefix length
    /// descending (longest first). On matchit NoMatch, `select_not_found`
    /// scans this table for the best segment-boundary prefix match and returns
    /// the catch-all's `route_id`. Empty when the app declares no catch-alls
    /// (feature is purely additive).
    not_found_table: RwLock<Vec<(String, u32)>>,
}

impl RouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the table from `manifest.routes` in manifest order, so
    /// `route_id == index into manifest.routes`. Catch-alls are root-level in
    /// M2 (`not_found_prefix = ""`); nested prefixes arrive with the compiler
    /// in M3 and `select_not_found` already handles them.
    pub fn from_manifest(m: &Manifest) -> Result<Self, RouteInstallError> {
        let configs: Vec<RouteConfig> = m
            .routes
            .iter()
            .map(|r| RouteConfig {
                path: r.pattern.clone(),
                cache: r.cache.clone(),
                not_found: r.catch_all,
                not_found_prefix: String::new(),
            })
            .collect();
        let table = Self::new();
        table.install_with_config(&configs)?;
        Ok(table)
    }

    /// Index into `manifest.routes` for a matched `route_id` (identity: the
    /// table is installed in manifest order).
    pub fn route_index(&self, route_id: u32) -> usize {
        route_id as usize
    }

    /// Replace the route set + per-route cache configs. Patterns are inserted
    /// in array order; index = route_id.
    pub fn install_with_config(&self, configs: &[RouteConfig]) -> Result<u32, RouteInstallError> {
        let mut router = matchit::Router::new();
        let mut caches: Vec<Option<RouteCache>> = Vec::with_capacity(configs.len());
        let mut compiled: Vec<Arc<CompiledCache>> = Vec::with_capacity(configs.len());
        let mut nf_table: Vec<(String, u32)> = Vec::new();
        for (idx, c) in configs.iter().enumerate() {
            // Catch-all routes (notFound: true) are NOT inserted into matchit.
            // They are registered in the not-found fallback table keyed by
            // their effective prefix. The parallel Vecs (caches/compiled)
            // still get entries so route_id == array index is preserved on both
            // sides (Rust idx as u32 ↔ TS byRouteId).
            if c.not_found {
                nf_table.push((c.not_found_prefix.clone(), idx as u32));
                // Still push to the parallel Vecs to keep indices aligned.
                caches.push(c.cache.clone());
                compiled.push(Arc::new(CompiledCache::default()));
                continue;
            }
            router
                .insert(c.path.clone(), idx as u32)
                .map_err(|e| RouteInstallError::Insert {
                    pattern: c.path.clone(),
                    reason: e.to_string(),
                })?;
            let compiled_cache = match &c.cache {
                Some(cc) => {
                    let prefix =
                        match &cc.prefix {
                            Some(s) => Some(Expr::parse(s).map_err(|reason| {
                                RouteInstallError::CacheExpr {
                                    pattern: c.path.clone(),
                                    field: "prefix",
                                    reason,
                                }
                            })?),
                            None => None,
                        };
                    let bypass = match &cc.bypass {
                        None => None,
                        Some(BypassSpec::Always(true)) => Some(None),
                        Some(BypassSpec::Always(false)) => None,
                        Some(BypassSpec::Expr(s)) => {
                            Some(Some(Expr::parse(s).map_err(|reason| {
                                RouteInstallError::CacheExpr {
                                    pattern: c.path.clone(),
                                    field: "bypass",
                                    reason,
                                }
                            })?))
                        }
                    };
                    CompiledCache { prefix, bypass }
                }
                None => CompiledCache::default(),
            };
            caches.push(c.cache.clone());
            compiled.push(Arc::new(compiled_cache));
        }
        // No sort needed: select_not_found uses max_by_key, which finds the
        // longest matching prefix regardless of table order.
        *self.inner.write() = router;
        *self.cache_configs.write() = caches;
        *self.compiled_caches.write() = compiled;
        *self.not_found_table.write() = nf_table;
        Ok(configs.len() as u32)
    }

    /// Compiled L1 prefix/bypass directives for a route, parallel to
    /// `cache_for`. `None` when the route_id is out of range.
    pub fn compiled_cache_for(&self, route_id: u32) -> Option<Arc<CompiledCache>> {
        // Returns an Arc clone (refcount bump), NOT a deep clone of the Expr
        // trees — this is the per-request cache hot path.
        self.compiled_caches.read().get(route_id as usize).cloned()
    }

    pub fn cache_for(&self, route_id: u32) -> Option<RouteCache> {
        self.cache_configs
            .read()
            .get(route_id as usize)
            .and_then(|c| c.clone())
    }

    pub fn match_path<'a>(
        &self,
        method: &'a str,
        full_path: &'a str,
        headers: &'a http::HeaderMap,
    ) -> MatchResult<'a> {
        let (path_only, query) = match full_path.split_once('?') {
            Some((p, q)) => (p, q),
            None => (full_path, ""),
        };
        let router = self.inner.read();
        match router.at(path_only) {
            Ok(matched) => {
                let route_id = *matched.value;
                let mut params = Vec::new();
                for (k, v) in matched.params.iter() {
                    // Decode at the production site — loaders, clientLoader,
                    // L1 param() key expressions, x-props, native ctx, and
                    // treaty all consume THIS vec (directly or serialized),
                    // so one decode keeps every consumer consistent.
                    params.push((std::borrow::Cow::Owned(k.to_string()), decode_path_param(v)));
                }
                let req = build_request_envelope(method, full_path, query, headers);
                let envelope = RouteEnvelope {
                    route_id,
                    path: full_path,
                    params,
                    req,
                };
                MatchResult::Matched { route_id, envelope }
            }
            Err(_) => {
                // Release the not-found-table lock before building the
                // envelope (scoped read, as in 0.1.x).
                let nf_id = {
                    let nf_table = self.not_found_table.read();
                    select_not_found(&nf_table, path_only)
                };
                match nf_id {
                    Some(id) => {
                        let req = build_request_envelope(method, full_path, query, headers);
                        let envelope = RouteEnvelope {
                            route_id: id,
                            path: full_path,
                            params: Vec::new(),
                            req,
                        };
                        MatchResult::NotFound {
                            route_id: id,
                            envelope,
                        }
                    }
                    None => MatchResult::NoMatch,
                }
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RouteInstallError {
    #[error("invalid route pattern {pattern:?}: {reason}")]
    Insert { pattern: String, reason: String },
    #[error("route {pattern:?}: invalid cache.{field} expression: {reason}")]
    CacheExpr {
        pattern: String,
        field: &'static str,
        reason: String,
    },
}

fn build_request_envelope<'a>(
    method: &'a str,
    full_path: &'a str,
    query: &'a str,
    request_headers: &'a http::HeaderMap,
) -> RequestEnvelope<'a> {
    // Iterate the hyper HeaderMap directly. The pre-refactor path rebuilt a raw
    // header block from THIS SAME HeaderMap (`reconstruct_raw_headers`) and then
    // httparse-parsed it, so the iteration order here matches the old envelope
    // byte-for-byte: HeaderMap::iter() yields lowercase names (HeaderName is
    // canonical-lowercase) and repeats an entry once per stored value, exactly
    // what the rebuilt-then-reparsed block produced.
    let mut headers = Vec::new();
    let mut cookies = Vec::new();
    for (name, value) in request_headers.iter() {
        let name_str = name.as_str();
        if name_str.is_empty() {
            continue;
        }
        // HeaderValue may carry non-UTF-8 bytes; match the old
        // `from_utf8(...).unwrap_or("")` fallback.
        let value_str = std::str::from_utf8(value.as_bytes()).unwrap_or("");
        if name == http::header::COOKIE {
            for pair in value_str.split(';') {
                let trimmed = pair.trim();
                if let Some((k, v)) = trimmed.split_once('=') {
                    cookies.push((k.trim(), std::borrow::Cow::Borrowed(v.trim())));
                }
            }
        }
        // HeaderName is always lowercase, so no per-name case normalization is
        // needed (the old code lowercased only when an uppercase char appeared).
        headers.push((
            std::borrow::Cow::Borrowed(name_str),
            std::borrow::Cow::Borrowed(value_str),
        ));
    }

    let mut search = Vec::new();
    if !query.is_empty() {
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            match pair.split_once('=') {
                Some((k, v)) => {
                    search.push((url_decode(k), url_decode(v)));
                }
                None => {
                    search.push((url_decode(pair), std::borrow::Cow::Borrowed("")));
                }
            }
        }
    }

    RequestEnvelope {
        method,
        url: full_path,
        headers,
        cookies,
        search,
    }
}

/// Percent-decode ONE matched path-param value (spec:
/// docs/superpowers/specs/2026-06-12-decode-params-design.md).
/// Full RFC-3986 decode including `%2F`; `+` stays literal (space-as-plus is
/// a query convention — url_decode above is NOT reusable here). Fallback is
/// per-VALUE: any malformed `%` sequence or invalid post-decode UTF-8 returns
/// the WHOLE raw capture, mirroring the client matchFallback's
/// `try { decodeURIComponent } catch { raw }` so server and client always
/// produce the same value. (percent_decode_str alone decodes per-SEQUENCE on
/// malformed input — hence the explicit pre-validation scan.)
pub(crate) fn decode_path_param(raw: &str) -> std::borrow::Cow<'_, str> {
    // Fast path + pre-validation in one scan: every '%' must be followed by
    // two hex digits, else the whole value ships raw.
    let bytes = raw.as_bytes();
    let mut has_pct = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            has_pct = true;
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return std::borrow::Cow::Borrowed(raw);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    if !has_pct {
        return std::borrow::Cow::Borrowed(raw);
    }
    match percent_encoding::percent_decode_str(raw).decode_utf8() {
        Ok(decoded) => decoded,
        Err(_) => std::borrow::Cow::Borrowed(raw),
    }
}

/// Minimal percent-decode for query-string keys/values. Decodes %xx and treats
/// `+` as space. Unrecognised escapes pass through unchanged.
fn url_decode(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('+') && !s.contains('%') {
        return std::borrow::Cow::Borrowed(s);
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push(((h << 4) | l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    std::borrow::Cow::Owned(String::from_utf8(out).unwrap_or_default())
}

/// Longest segment-boundary prefix match against the not-found table.
///
/// A prefix `p` matches `path` when:
/// - `p` is empty (root catch-all, matches everything), OR
/// - `path == p` (exact), OR
/// - `path` starts with `p/` (proper sub-path, not e.g. "/docsy" for "/docs").
///
/// Returns the `route_id` of the entry with the longest matching prefix, or
/// `None` when the table is empty or nothing matches.
///
/// Note on ties: two DISTINCT prefixes of equal length can never both match a
/// single path (a path cannot start with both `/foo/` and `/bar/`), so at most
/// one surviving entry exists per length — `max_by_key`'s tie-break is never
/// actually exercised, and install-time dedupe already forbids identical
/// prefixes. The check is allocation-free (no `format!`) since it runs on every
/// matchit miss.
fn select_not_found(table: &[(String, u32)], path: &str) -> Option<u32> {
    fn prefix_matches(p: &str, path: &str) -> bool {
        p.is_empty()
            || path == p
            // proper sub-path: `path` is `p` followed by a `/` boundary, so
            // "/docs" matches "/docs/x" but NOT "/docsy".
            || (path.len() > p.len() && path.starts_with(p) && path.as_bytes()[p.len()] == b'/')
    }
    table
        .iter()
        .filter(|(p, _)| prefix_matches(p, path))
        .max_by_key(|(p, _)| p.len())
        .map(|(_, id)| *id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an `http::HeaderMap` from `(name, value)` pairs, appending repeats
    /// (so multi-Cookie tests keep both values). Names are parsed as-is;
    /// HeaderName lowercases them, matching the wire→HeaderMap path hyper takes.
    fn hm(pairs: &[(&str, &str)]) -> http::HeaderMap {
        let mut map = http::HeaderMap::new();
        for (k, v) in pairs {
            let name = http::header::HeaderName::from_bytes(k.as_bytes()).unwrap();
            map.append(name, http::HeaderValue::from_str(v).unwrap());
        }
        map
    }

    #[test]
    fn decode_path_param_basic_and_multibyte() {
        use std::borrow::Cow;
        assert_eq!(decode_path_param("sa%20wad-dee"), "sa wad-dee");
        // Thai: สวัสดี
        assert_eq!(
            decode_path_param("%E0%B8%AA%E0%B8%A7%E0%B8%B1%E0%B8%AA%E0%B8%94%E0%B8%B5"),
            "สวัสดี"
        );
        assert_eq!(decode_path_param("a%2Fb"), "a/b"); // full decode incl. %2F
        assert_eq!(decode_path_param("a+b"), "a+b"); // + is literal in paths
        assert!(matches!(
            decode_path_param("plain-slug"),
            Cow::Borrowed("plain-slug")
        ));
    }

    #[test]
    fn decode_path_param_per_value_raw_fallback() {
        use std::borrow::Cow;
        // Malformed % → WHOLE value raw (pre-validation), mirroring
        // decodeURIComponent's per-value throw — NOT the crate's per-sequence
        // behavior (a%ZZ%41 must NOT become a%ZZA).
        assert!(matches!(
            decode_path_param("a%ZZ%41"),
            Cow::Borrowed("a%ZZ%41")
        ));
        assert!(matches!(decode_path_param("100%"), Cow::Borrowed("100%")));
        assert!(matches!(decode_path_param("%Z"), Cow::Borrowed("%Z")));
        // %FF%41 passes the hex pre-scan (both sequences are valid hex) and
        // falls back at the UTF-8 validation stage instead — still per-VALUE:
        // the valid %41 must NOT decode while %FF poisons the whole value.
        assert!(matches!(
            decode_path_param("%FF%41"),
            Cow::Borrowed("%FF%41")
        ));
        assert!(matches!(
            decode_path_param("%ED%A0%80"),
            Cow::Borrowed("%ED%A0%80")
        ));
    }

    #[test]
    fn match_path_params_arrive_decoded_incl_catch_all() {
        let table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/post/{slug}".into(),
                    cache: None,
                    ..Default::default()
                },
                RouteConfig {
                    path: "/files/{*rest}".into(),
                    cache: None,
                    ..Default::default()
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/post/sa%20wad-dee", &headers) {
            MatchResult::Matched { envelope, .. } => {
                assert_eq!(envelope.params[0].1.as_ref(), "sa wad-dee");
            }
            _ => panic!("no match"),
        }
        match table.match_path("GET", "/files/a%2Fb/c", &headers) {
            MatchResult::Matched { envelope, .. } => {
                assert_eq!(envelope.params[0].1.as_ref(), "a/b/c");
            }
            _ => panic!("no match"),
        }
    }

    #[test]
    fn url_decode_passes_through_ascii() {
        assert_eq!(url_decode("abc"), "abc");
        assert_eq!(url_decode(""), "");
    }

    #[test]
    fn url_decode_plus_to_space() {
        assert_eq!(url_decode("a+b"), "a b");
    }

    #[test]
    fn url_decode_percent_hex_both_cases() {
        assert_eq!(url_decode("%41"), "A");
        assert_eq!(url_decode("%4f"), "O");
        assert_eq!(url_decode("%4F"), "O");
    }

    #[test]
    fn url_decode_multibyte_utf8() {
        assert_eq!(url_decode("%E2%9C%93"), "\u{2713}");
    }

    #[test]
    fn url_decode_trailing_percent_passes_through() {
        assert_eq!(url_decode("%"), "%");
        assert_eq!(url_decode("a%"), "a%");
    }

    #[test]
    fn url_decode_short_escape_passes_through() {
        // Only 1 trailing nibble — bounds check fails, falls through literally.
        assert_eq!(url_decode("%4"), "%4");
    }

    #[test]
    fn url_decode_invalid_hex_passes_through() {
        assert_eq!(url_decode("%ZZ"), "%ZZ");
        assert_eq!(url_decode("%G1"), "%G1");
    }

    #[test]
    fn url_decode_invalid_utf8_collapses_to_empty() {
        // %FF%FE is not valid UTF-8 — current contract collapses to "".
        assert_eq!(url_decode("%FF%FE"), "");
    }

    #[test]
    fn envelope_parses_cookies_from_single_header() {
        let headers = hm(&[("Host", "x"), ("Cookie", "user=alice; sid=xyz")]);
        let env = build_request_envelope("GET", "/x", "", &headers);
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "user")
                .map(|(_, v)| v.as_ref()),
            Some("alice")
        );
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "sid")
                .map(|(_, v)| v.as_ref()),
            Some("xyz")
        );
    }

    #[test]
    fn envelope_merges_cookies_across_multiple_cookie_headers() {
        // RFC 6265 S5.4 allows a single Cookie header per request, but
        // some proxies fold/split. Both cookies should appear in the map.
        let headers = hm(&[("Host", "x"), ("Cookie", "a=1"), ("Cookie", "b=2")]);
        let env = build_request_envelope("GET", "/x", "", &headers);
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "a")
                .map(|(_, v)| v.as_ref()),
            Some("1")
        );
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "b")
                .map(|(_, v)| v.as_ref()),
            Some("2")
        );
    }

    #[test]
    fn envelope_parses_search_with_key_only_and_empty_value() {
        let headers = http::HeaderMap::new();
        let env = build_request_envelope(
            "GET",
            "/x?name=brust&flag&empty=",
            "name=brust&flag&empty=",
            &headers,
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "name")
                .map(|(_, v)| v.as_ref()),
            Some("brust")
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "flag")
                .map(|(_, v)| v.as_ref()),
            Some("")
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "empty")
                .map(|(_, v)| v.as_ref()),
            Some("")
        );
    }

    #[test]
    fn envelope_parses_search_with_percent_and_plus() {
        let headers = http::HeaderMap::new();
        let env = build_request_envelope(
            "GET",
            "/x?greet=hello+world&unicode=%E2%9C%93",
            "greet=hello+world&unicode=%E2%9C%93",
            &headers,
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "greet")
                .map(|(_, v)| v.as_ref()),
            Some("hello world"),
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "unicode")
                .map(|(_, v)| v.as_ref()),
            Some("\u{2713}"),
        );
    }

    #[test]
    fn envelope_empty_request_safe() {
        let headers = http::HeaderMap::new();
        let env = build_request_envelope("GET", "/x", "", &headers);
        assert_eq!(env.method, "GET");
        assert_eq!(env.url, "/x");
        assert!(env.headers.is_empty());
        assert!(env.cookies.is_empty());
        assert!(env.search.is_empty());
    }

    #[test]
    fn route_envelope_serializes_route_id_and_path() {
        let table = RouteTable::new();
        let cfg = RouteConfig {
            path: "/foo".into(),
            cache: None,
            ..Default::default()
        };
        table.install_with_config(&[cfg]).unwrap();
        let headers = hm(&[("Host", "x")]);
        let result = table.match_path("GET", "/foo", &headers);
        match result {
            MatchResult::Matched { envelope, .. } => {
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
                assert!(parsed.get("kind").is_none(), "v2 envelope has no kind");
                assert_eq!(parsed["route_id"], 0);
                assert_eq!(parsed["path"], "/foo");
            }
            MatchResult::NotFound { .. } | MatchResult::NoMatch => {
                panic!("expected match for /foo")
            }
        }
    }

    // ---- not-found fallback tier tests ----

    #[test]
    fn select_not_found_longest_segment_prefix() {
        let t = vec![(String::new(), 9u32), ("/docs".into(), 3u32)];
        assert_eq!(select_not_found(&t, "/docs/missing"), Some(3));
        assert_eq!(select_not_found(&t, "/other"), Some(9)); // root last-resort
        assert_eq!(select_not_found(&t, "/docs"), Some(3)); // exact prefix
        assert_eq!(select_not_found(&t, "/docsearch"), Some(9)); // NOT /docs (boundary)
    }

    #[test]
    fn select_not_found_empty_table_is_none() {
        assert_eq!(select_not_found(&[], "/x"), None);
    }

    #[test]
    fn select_not_found_root_only_matches_everything() {
        let t = vec![(String::new(), 0u32)];
        assert_eq!(select_not_found(&t, "/anything/at/all"), Some(0));
        assert_eq!(select_not_found(&t, "/"), Some(0));
    }

    #[test]
    fn select_not_found_no_root_no_match_returns_none() {
        let t = vec![("/docs".into(), 3u32)];
        assert_eq!(select_not_found(&t, "/other"), None);
    }

    #[test]
    fn match_path_returns_not_found_when_catchall_registered() {
        let table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/home".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: String::new(), // sentinel fullPath for catch-all
                    cache: None,
                    not_found: true,
                    not_found_prefix: String::new(), // root prefix
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/unmatched", &headers) {
            MatchResult::NotFound { route_id, .. } => {
                assert_eq!(route_id, 1, "catch-all has route_id = 1 (index 1)");
            }
            MatchResult::Matched { .. } => panic!("expected NotFound, got Matched"),
            MatchResult::NoMatch => panic!("expected NotFound, got NoMatch"),
        }
    }

    #[test]
    fn match_path_returns_no_match_when_table_empty() {
        let table = RouteTable::new();
        table
            .install_with_config(&[RouteConfig {
                path: "/home".into(),
                cache: None,
                not_found: false,
                not_found_prefix: String::new(),
            }])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/unmatched", &headers) {
            MatchResult::NoMatch => {} // expected
            MatchResult::NotFound { .. } => panic!("expected NoMatch, got NotFound"),
            MatchResult::Matched { .. } => panic!("expected NoMatch, got Matched"),
        }
    }

    #[test]
    fn match_path_real_route_still_matches_when_catchall_installed() {
        let table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/home".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: String::new(),
                    cache: None,
                    not_found: true,
                    not_found_prefix: String::new(),
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/home", &headers) {
            MatchResult::Matched { route_id, .. } => {
                assert_eq!(route_id, 0);
            }
            _other => panic!(
                "expected Matched for /home, got something else: route_id would be in other variant"
            ),
        }
    }

    #[test]
    fn install_not_found_config_from_json() {
        // Simulate the JSON payload the TS side sends for a catch-all route.
        let json = r#"[
            {"path":"/"},
            {"path":"","notFound":true,"notFoundPrefix":""}
        ]"#;
        let configs: Vec<RouteConfig> = serde_json::from_str(json).unwrap();
        assert!(configs[1].not_found, "not_found should be true");
        assert_eq!(configs[1].not_found_prefix, "");

        let table = RouteTable::new();
        table.install_with_config(&configs).unwrap();

        // Catch-all must NOT be in matchit — /home should not match /
        let headers = http::HeaderMap::new();
        // "/" is a real route (route_id 0)
        match table.match_path("GET", "/", &headers) {
            MatchResult::Matched { route_id, .. } => assert_eq!(route_id, 0),
            _other => panic!("expected Matched for /"),
        }
        // "/missing" should hit the catch-all (route_id 1)
        match table.match_path("GET", "/missing", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 1),
            _other => panic!("expected NotFound for /missing"),
        }
        // the catch-all envelope carries its own route_id and no params
        match table.match_path("GET", "/anything", &headers) {
            MatchResult::NotFound { envelope, .. } => {
                assert_eq!(envelope.route_id, 1);
                assert!(envelope.params.is_empty());
            }
            _other => panic!("expected NotFound for /anything"),
        }
    }

    #[test]
    fn install_nested_catchall_prefix_selection() {
        // /docs catch-all (route_id 2) should win over root (route_id 3) for /docs/missing
        let table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: "/docs/intro".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: String::new(),
                    cache: None,
                    not_found: true,
                    not_found_prefix: "/docs".into(),
                },
                RouteConfig {
                    path: String::new(),
                    cache: None,
                    not_found: true,
                    not_found_prefix: String::new(),
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        // /docs/missing → docs catch-all (route_id 2)
        match table.match_path("GET", "/docs/missing", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 2),
            _other => panic!("expected NotFound with docs catch-all for /docs/missing"),
        }
        // /other → root catch-all (route_id 3)
        match table.match_path("GET", "/other", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 3),
            _other => panic!("expected NotFound with global catch-all for /other"),
        }
        // /docsearch → root (segment boundary respected)
        match table.match_path("GET", "/docsearch", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 3),
            _other => panic!("expected global catch-all for /docsearch (boundary)"),
        }
    }

    #[test]
    fn install_rejects_bad_prefix_expr() {
        let table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/bad".into(),
            cache: Some(crate::manifest::RouteCache {
                ttl_seconds: 60,
                prefix: Some("or(cookie(x)".into()),
                bypass: None,
                tags: vec![],
            }),
            ..Default::default()
        }];
        let err = table.install_with_config(&cfgs).unwrap_err();
        assert!(
            matches!(
                err,
                RouteInstallError::CacheExpr {
                    field: "prefix",
                    ..
                }
            ),
            "expected CacheExpr error for malformed prefix, got {err:?}"
        );
    }

    #[test]
    fn install_rejects_bad_bypass_expr() {
        let table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/bad".into(),
            cache: Some(crate::manifest::RouteCache {
                ttl_seconds: 60,
                prefix: None,
                bypass: Some(crate::manifest::BypassSpec::Expr("uuid(v4)".into())),
                tags: vec![],
            }),
            ..Default::default()
        }];
        let err = table.install_with_config(&cfgs).unwrap_err();
        assert!(
            matches!(
                err,
                RouteInstallError::CacheExpr {
                    field: "bypass",
                    ..
                }
            ),
            "expected CacheExpr error for non-deterministic bypass, got {err:?}"
        );
    }

    #[test]
    fn compiled_cache_for_parses_prefix_and_bypass() {
        let table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/p".into(),
            cache: Some(crate::manifest::RouteCache {
                ttl_seconds: 60,
                prefix: Some("cookie(tenant)".into()),
                bypass: Some(crate::manifest::BypassSpec::Always(true)),
                tags: vec![],
            }),
            ..Default::default()
        }];
        table.install_with_config(&cfgs).unwrap();
        let cc = table.compiled_cache_for(0).expect("compiled cache present");
        assert!(cc.prefix.is_some());
        assert!(matches!(cc.bypass, Some(None)), "Always(true) ⇒ Some(None)");
    }

    #[test]
    fn from_manifest_installs_catch_all_outside_matchit() {
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist");
        let loaded = crate::manifest::Manifest::load(&dist).unwrap();
        let table = RouteTable::from_manifest(&loaded.manifest).unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/nope", &headers) {
            MatchResult::NotFound { route_id, .. } => {
                assert_eq!(route_id, 3);
                assert_eq!(table.route_index(route_id), 3);
            }
            _other => panic!("expected NotFound for /nope"),
        }
        match table.match_path("GET", "/pokemon/pikachu", &headers) {
            MatchResult::Matched { route_id, envelope } => {
                assert_eq!(route_id, 1);
                assert_eq!(envelope.params[0].0.as_ref(), "name");
                assert_eq!(envelope.params[0].1.as_ref(), "pikachu");
            }
            _other => panic!("expected Matched for /pokemon/pikachu"),
        }
        let cc = table.compiled_cache_for(2).expect("r3 compiled cache");
        assert!(cc.prefix.is_some() && matches!(cc.bypass, Some(Some(_))));
        assert_eq!(
            table.cache_for(1).map(|c| c.tags),
            Some(vec!["pokemon".to_string()])
        );
    }
}
