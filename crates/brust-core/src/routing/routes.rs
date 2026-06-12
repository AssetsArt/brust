use std::sync::Arc;

use parking_lot::RwLock;
use serde::Deserialize;
use serde::Serialize;

use crate::cache::key_expr::Expr;
use crate::cache::response_cache::{BypassSpec, CacheConfig};

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

/// JSON envelope shipped across the tsfn boundary for each render call.
/// `kind: "render"` discriminates from the action variant; JS dispatcher
/// switches on this field. See ActionEnvelope below for the other variant.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub kind: &'static str,
    pub route_id: u32,
    pub path: &'a str,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub params: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
    pub req: RequestEnvelope<'a>,
    /// Sub-project J — when the route was registered with `native: true`,
    /// the JS-side ships `nativeTemplate: Component.name`. JS dispatcher
    /// branches on the presence of this field to call `napiRenderJinja`
    /// instead of the React render path.
    #[serde(skip_serializing_if = "Option::is_none", rename = "nativeTemplate")]
    pub native_template: Option<std::borrow::Cow<'a, str>>,
    /// Two-layer page cache: set true by the server when `bypass` routed this
    /// request to L2. The worker reads it to decide whether to run `cache.key`
    /// (L2 capture/replay). Defaults false; serializes always so the worker's
    /// `RouteCall` can read it.
    #[serde(default)]
    pub bypassed: bool,
}

/// Mirrors RouteEnvelope but carries a string action_id (not numeric route_id)
/// and a content-type-aware body. `kind: "action"` discriminates from the
/// render variant. Exactly ONE of body_text / body_b64 is Some, decided by
/// the request's Content-Type header (see src/server.rs).
#[derive(Serialize)]
pub struct ActionEnvelope<'a> {
    pub kind: &'static str,
    pub action_id: &'a str,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub params: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
    /// Request's Content-Type header, whitespace-trimmed (case PRESERVED —
    /// JS lowercases defensively at the dispatch point). Empty string means
    /// the header was missing. JS dispatcher branches on this.
    pub content_type: &'a str,
    /// UTF-8-validated text body. Present for application/json and
    /// application/x-www-form-urlencoded. Absent for multipart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_text: Option<&'a str>,
    /// Base64-encoded binary body. Present for multipart/form-data.
    /// JS decodes via Buffer.from(s, 'base64') before parsing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_b64: Option<&'a str>,
    pub req: RequestEnvelope<'a>,
}

/// MCP JSON-RPC request envelope. `kind: "mcp"` discriminates from render
/// and action variants at the JS dispatcher; the JS-side `mcpBranch` then
/// parses `body_text` and switches on the JSON-RPC `method` field.
#[derive(Serialize)]
pub struct McpEnvelope<'a> {
    pub kind: &'static str,
    pub body_text: &'a str,
    pub req: RequestEnvelope<'a>,
}

pub(crate) fn build_mcp_envelope<'a>(
    method: &'a str,
    full_path: &'a str,
    body_text: &'a str,
    headers: &'a http::HeaderMap,
) -> McpEnvelope<'a> {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, headers);
    McpEnvelope {
        kind: "mcp",
        body_text,
        req,
    }
}

/// SSE request envelope. `kind: "sse"` discriminates from render/action/mcp.
/// `conn_id` is the Rust-assigned monotonic id; the worker carries it back via
/// napi_sse_write / napi_sse_close / napi_sse_signal_open so Rust can correlate
/// chunks/lifecycle to the per-connection task.
#[derive(Serialize)]
pub struct SseEnvelope<'a> {
    pub kind: &'static str,
    pub conn_id: u64,
    pub req: RequestEnvelope<'a>,
}

pub(crate) fn build_sse_envelope<'a>(
    method: &'a str,
    full_path: &'a str,
    headers: &'a http::HeaderMap,
    conn_id: u64,
) -> SseEnvelope<'a> {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, headers);
    SseEnvelope {
        kind: "sse",
        conn_id,
        req,
    }
}

/// WS upgrade request envelope. `kind: "ws"` discriminates from
/// render/action/mcp/sse. `conn_id` is the Rust-assigned monotonic id
/// (shared with SSE via the same NEXT_CONN_ID counter; separate
/// REGISTRY tables avoid collision). `client_subprotocols` is the
/// comma-split `Sec-WebSocket-Protocol` request value (trimmed); JS
/// picks the first match against `route.wsOptions.subprotocols` and
/// signals back via napi_ws_signal_open.
#[derive(Serialize)]
pub struct WsEnvelope<'a> {
    pub kind: &'static str,
    pub conn_id: u64,
    pub client_subprotocols: Vec<String>,
    pub req: RequestEnvelope<'a>,
}

pub(crate) fn build_ws_envelope<'a>(
    method: &'a str,
    full_path: &'a str,
    headers: &'a http::HeaderMap,
    conn_id: u64,
    client_subprotocols: Vec<String>,
) -> WsEnvelope<'a> {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, headers);
    WsEnvelope {
        kind: "ws",
        conn_id,
        client_subprotocols,
        req,
    }
}

/// Build an ActionEnvelope JSON string. Mirrors `match_path` for the render
/// case. Caller has already validated the action_id charset and registry
/// membership; this function only assembles the envelope.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_action_envelope<'a>(
    method: &'a str,
    full_path: &'a str,
    action_id: &'a str,
    params: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
    content_type: &'a str,
    body_text: Option<&'a str>,
    body_b64: Option<&'a str>,
    headers: &'a http::HeaderMap,
) -> ActionEnvelope<'a> {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, headers);
    ActionEnvelope {
        kind: "action",
        action_id,
        params,
        content_type,
        body_text,
        body_b64,
        req,
    }
}

/// Outcome of a match against the radix tree.
pub enum MatchResult<'a> {
    Matched {
        route_id: u32,
        envelope: RouteEnvelope<'a>,
    },
    NoMatch,
}

#[derive(Debug, Deserialize)]
pub struct RouteConfig {
    pub path: String,
    #[serde(default)]
    pub cache: Option<CacheConfig>,
    /// Sub-project J — JS-side ships `nativeTemplate: Component.name` when
    /// the route has `native: true`. Rust uses this name to dispatch via
    /// minijinja instead of React. See spec S3 + S4.
    #[serde(default, rename = "nativeTemplate")]
    pub native_template: Option<String>,
}

#[derive(Default)]
pub struct RouteTable {
    inner: RwLock<matchit::Router<u32>>,
    cache_configs: RwLock<Vec<Option<CacheConfig>>>,
    /// Compiled L1 prefix/bypass expressions, parallel to `cache_configs`.
    /// Index = route_id. Parsed once at install; evaluated per request.
    compiled_caches: RwLock<Vec<Arc<CompiledCache>>>,
    /// Sub-project J — per-route-id native template name (parallel to
    /// `cache_configs`). Index = route_id. `None` ⇒ React-rendered route.
    native_templates: RwLock<Vec<Option<String>>>,
}

impl RouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the route set + per-route cache configs. Patterns are inserted
    /// in array order; index = route_id.
    pub fn install_with_config(&self, configs: &[RouteConfig]) -> Result<u32, RouteInstallError> {
        let mut router = matchit::Router::new();
        let mut caches: Vec<Option<CacheConfig>> = Vec::with_capacity(configs.len());
        let mut compiled: Vec<Arc<CompiledCache>> = Vec::with_capacity(configs.len());
        let mut natives: Vec<Option<String>> = Vec::with_capacity(configs.len());
        for (idx, c) in configs.iter().enumerate() {
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
            natives.push(c.native_template.clone());
        }
        *self.inner.write() = router;
        *self.cache_configs.write() = caches;
        *self.compiled_caches.write() = compiled;
        *self.native_templates.write() = natives;
        Ok(configs.len() as u32)
    }

    /// Compiled L1 prefix/bypass directives for a route, parallel to
    /// `cache_for`. `None` when the route_id is out of range.
    pub fn compiled_cache_for(&self, route_id: u32) -> Option<Arc<CompiledCache>> {
        // Returns an Arc clone (refcount bump), NOT a deep clone of the Expr
        // trees — this is the per-request cache hot path.
        self.compiled_caches.read().get(route_id as usize).cloned()
    }

    pub fn cache_for(&self, route_id: u32) -> Option<CacheConfig> {
        self.cache_configs
            .read()
            .get(route_id as usize)
            .and_then(|c| c.clone())
    }

    /// Sub-project J — per-route-id lookup of the native template name.
    /// Returns `None` when the route is React-rendered (no `native: true`).
    /// Used by the render dispatch in server.rs to route native routes through
    /// the channel-free `dispatch_single_chunk` fast path.
    pub fn native_template_for(&self, route_id: u32) -> Option<String> {
        self.native_templates
            .read()
            .get(route_id as usize)
            .and_then(|n| n.clone())
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
                let native = self
                    .native_templates
                    .read()
                    .get(route_id as usize)
                    .and_then(|n| n.clone());
                let envelope = RouteEnvelope {
                    kind: "render",
                    route_id,
                    path: full_path,
                    params,
                    req,
                    native_template: native.map(std::borrow::Cow::Owned),
                    bypassed: false,
                };
                MatchResult::Matched { route_id, envelope }
            }
            Err(_) => MatchResult::NoMatch,
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

/// Swap `"kind":"<old>"` → `"kind":"<new>"` in a JS-built JSON envelope
/// string. The envelope's field order is stable (the JS builder always
/// emits `kind` first), so a single targeted substring replace is correct
/// and cheaper than a parse-rewrite-serialise round-trip. Returns the input
/// unchanged if the `"kind":"render"` substring isn't found (defensive).
///
/// NOTE (2026-05): currently exercised only by its unit tests — the live
/// navigation path mutates `envelope.kind` directly on the struct before
/// serialising (see `server.rs`), so this string-rewrite helper is presently
/// unused in production. Kept (allow dead_code) pending a decision to either
/// re-adopt it or delete it + its tests.
#[allow(dead_code)]
pub(crate) fn rewrite_envelope_kind(envelope_json: String, new_kind: &str) -> String {
    envelope_json.replacen(
        r#""kind":"render""#,
        &format!(r#""kind":"{}""#, new_kind),
        1,
    )
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
                    native_template: None,
                },
                RouteConfig {
                    path: "/files/{*rest}".into(),
                    cache: None,
                    native_template: None,
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
    fn render_envelope_has_kind_discriminant() {
        let table = RouteTable::new();
        let cfg = RouteConfig {
            path: "/foo".into(),
            cache: None,
            native_template: None,
        };
        table.install_with_config(&[cfg]).unwrap();
        let headers = hm(&[("Host", "x")]);
        let result = table.match_path("GET", "/foo", &headers);
        match result {
            MatchResult::Matched { envelope, .. } => {
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
                assert_eq!(parsed["kind"], "render");
                assert_eq!(parsed["route_id"], 0);
                assert_eq!(parsed["path"], "/foo");
            }
            MatchResult::NoMatch => panic!("expected match for /foo"),
        }
    }

    #[test]
    fn action_envelope_json_path() {
        let headers = hm(&[("Host", "x")]);
        let env = build_action_envelope(
            "POST",
            "/_brust/action/createNote",
            "createNote",
            vec![],
            "application/json",
            Some(r#"["hello"]"#),
            None,
            &headers,
        );
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "action");
        assert_eq!(parsed["action_id"], "createNote");
        assert_eq!(parsed["content_type"], "application/json");
        assert_eq!(parsed["body_text"], r#"["hello"]"#);
        // body_b64 must be absent on the JSON path (skip_serializing_if).
        assert!(parsed.get("body_b64").is_none());
        assert_eq!(parsed["req"]["method"], "POST");
    }

    #[test]
    fn action_envelope_form_urlencoded_path() {
        let headers = hm(&[("Host", "x")]);
        let env = build_action_envelope(
            "POST",
            "/_brust/action/registerUser",
            "registerUser",
            vec![],
            "application/x-www-form-urlencoded",
            Some("name=Alice&age=30"),
            None,
            &headers,
        );
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "action");
        assert_eq!(parsed["content_type"], "application/x-www-form-urlencoded");
        assert_eq!(parsed["body_text"], "name=Alice&age=30");
        assert!(parsed.get("body_b64").is_none());
    }

    #[test]
    fn action_envelope_multipart_path() {
        let headers = hm(&[("Host", "x")]);
        let env = build_action_envelope(
            "POST",
            "/_brust/action/uploadAvatar",
            "uploadAvatar",
            vec![],
            "multipart/form-data; boundary=abc",
            None,
            Some("LS1hYmMNCkNvbnRlbnQt"),
            &headers,
        );
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "action");
        assert_eq!(parsed["content_type"], "multipart/form-data; boundary=abc");
        assert_eq!(parsed["body_b64"], "LS1hYmMNCkNvbnRlbnQt");
        assert!(parsed.get("body_text").is_none());
    }

    #[test]
    fn action_envelope_quoting_preserved() {
        // Pinned: actionBranch in JS does JSON.parse(body_text). Any quote loss
        // between Rust → napi → JS surfaces as a parse error in production.
        let headers = http::HeaderMap::new();
        let env = build_action_envelope(
            "POST",
            "/_brust/action/x",
            "x",
            vec![],
            "application/json",
            Some(r#"["hi \"there\"", 42]"#),
            None,
            &headers,
        );
        let json = serde_json::to_string(&env).unwrap();
        let outer: serde_json::Value = serde_json::from_str(&json).unwrap();
        let inner: serde_json::Value =
            serde_json::from_str(outer["body_text"].as_str().unwrap()).unwrap();
        assert_eq!(inner[0], r#"hi "there""#);
        assert_eq!(inner[1], 42);
    }

    #[test]
    fn mcp_envelope_serialises_kind_mcp() {
        let headers = hm(&[("Host", "x"), ("Content-Type", "application/json")]);
        let env = build_mcp_envelope(
            "POST",
            "/_brust/mcp",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            &headers,
        );
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "mcp");
        assert_eq!(
            parsed["body_text"],
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#
        );
        assert_eq!(parsed["req"]["method"], "POST");
    }

    #[test]
    fn mcp_envelope_preserves_inner_quotes() {
        let inner = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"text":"hi \"there\""}}}"#;
        let headers = http::HeaderMap::new();
        let env = build_mcp_envelope("POST", "/_brust/mcp", inner, &headers);
        let json = serde_json::to_string(&env).unwrap();
        let outer: serde_json::Value = serde_json::from_str(&json).unwrap();
        let recovered: serde_json::Value =
            serde_json::from_str(outer["body_text"].as_str().unwrap()).unwrap();
        assert_eq!(recovered["params"]["arguments"]["text"], r#"hi "there""#);
    }

    #[test]
    fn sse_envelope_serialises_kind_sse_and_conn_id() {
        let headers = hm(&[("Host", "x"), ("Accept", "text/event-stream")]);
        let env = build_sse_envelope("GET", "/sse-counter", &headers, 42u64);
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "sse");
        assert_eq!(parsed["conn_id"], 42);
        assert_eq!(parsed["req"]["method"], "GET");
        assert_eq!(parsed["req"]["url"], "/sse-counter");
    }

    #[test]
    fn sse_envelope_preserves_query_string() {
        let headers = hm(&[("Host", "x")]);
        let env = build_sse_envelope("GET", "/events?topic=news", &headers, 7u64);
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "sse");
        assert_eq!(parsed["conn_id"], 7);
        assert_eq!(parsed["req"]["url"], "/events?topic=news");
    }

    #[test]
    fn ws_envelope_serialises_kind_ws_and_conn_id() {
        let headers = hm(&[
            ("Host", "x"),
            ("Upgrade", "websocket"),
            ("Connection", "Upgrade"),
        ]);
        let env = build_ws_envelope(
            "GET",
            "/ws/chat",
            &headers,
            42u64,
            vec!["chat.v2".to_string(), "chat.v1".to_string()],
        );
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "ws");
        assert_eq!(parsed["conn_id"], 42);
        assert_eq!(parsed["req"]["method"], "GET");
        assert_eq!(parsed["req"]["url"], "/ws/chat");
        assert_eq!(parsed["client_subprotocols"][0], "chat.v2");
        assert_eq!(parsed["client_subprotocols"][1], "chat.v1");
    }

    #[test]
    fn ws_envelope_empty_subprotocols() {
        let headers = hm(&[("Host", "x")]);
        let env = build_ws_envelope("GET", "/ws/echo", &headers, 7u64, vec![]);
        let json = serde_json::to_string(&env).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "ws");
        assert_eq!(parsed["conn_id"], 7);
        assert!(parsed["client_subprotocols"].as_array().unwrap().is_empty());
    }

    #[test]
    fn route_table_natives_indexed_by_route_id() {
        let table = RouteTable::new();
        let cfgs = vec![
            RouteConfig {
                path: "/a".into(),
                cache: None,
                native_template: None,
            },
            RouteConfig {
                path: "/b".into(),
                cache: None,
                native_template: Some("Profile".into()),
            },
            RouteConfig {
                path: "/c".into(),
                cache: None,
                native_template: None,
            },
        ];
        table.install_with_config(&cfgs).unwrap();
        assert_eq!(table.native_template_for(0), None);
        assert_eq!(table.native_template_for(1), Some("Profile".to_string()));
        assert_eq!(table.native_template_for(2), None);
    }

    #[test]
    fn envelope_includes_native_template_when_set() {
        let table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/x".into(),
            cache: None,
            native_template: Some("MyPage".into()),
        }];
        table.install_with_config(&cfgs).unwrap();
        let headers = hm(&[("Host", "x")]);
        let result = table.match_path("GET", "/x", &headers);
        match result {
            MatchResult::Matched { envelope, .. } => {
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
                assert_eq!(parsed["nativeTemplate"], "MyPage");
            }
            _ => panic!("expected match"),
        }
    }

    #[test]
    fn install_rejects_bad_prefix_expr() {
        let table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/bad".into(),
            cache: Some(crate::cache::response_cache::CacheConfig {
                ttl_seconds: 60,
                prefix: Some("or(cookie(x)".into()),
                bypass: None,
                tags: None,
            }),
            native_template: None,
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
            cache: Some(crate::cache::response_cache::CacheConfig {
                ttl_seconds: 60,
                prefix: None,
                bypass: Some(crate::cache::response_cache::BypassSpec::Expr(
                    "uuid(v4)".into(),
                )),
                tags: None,
            }),
            native_template: None,
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
            cache: Some(crate::cache::response_cache::CacheConfig {
                ttl_seconds: 60,
                prefix: Some("cookie(tenant)".into()),
                bypass: Some(crate::cache::response_cache::BypassSpec::Always(true)),
                tags: None,
            }),
            native_template: None,
        }];
        table.install_with_config(&cfgs).unwrap();
        let cc = table.compiled_cache_for(0).expect("compiled cache present");
        assert!(cc.prefix.is_some());
        assert!(matches!(cc.bypass, Some(None)), "Always(true) ⇒ Some(None)");
    }

    #[test]
    fn envelope_omits_native_template_when_unset() {
        let table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/y".into(),
            cache: None,
            native_template: None,
        }];
        table.install_with_config(&cfgs).unwrap();
        let headers = hm(&[("Host", "x")]);
        let result = table.match_path("GET", "/y", &headers);
        match result {
            MatchResult::Matched { envelope, .. } => {
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
                assert!(parsed.get("nativeTemplate").is_none());
            }
            _ => panic!("expected match"),
        }
    }
}

#[cfg(test)]
mod rewrite_envelope_kind_tests {
    use super::rewrite_envelope_kind;

    #[test]
    fn swap_render_to_navigation() {
        let envelope = r#"{"kind":"render","path":"/blog/x","route_id":2}"#.to_string();
        let out = rewrite_envelope_kind(envelope, "navigation");
        assert_eq!(
            out,
            r#"{"kind":"navigation","path":"/blog/x","route_id":2}"#
        );
    }

    #[test]
    fn replaces_only_first_occurrence() {
        let envelope = r#"{"kind":"render","data":"\"kind\":\"render\""}"#.to_string();
        let out = rewrite_envelope_kind(envelope, "navigation");
        assert_eq!(out, r#"{"kind":"navigation","data":"\"kind\":\"render\""}"#);
    }

    #[test]
    fn missing_kind_returns_input_unchanged() {
        let envelope = r#"{"foo":"bar"}"#.to_string();
        let out = rewrite_envelope_kind(envelope, "navigation");
        assert_eq!(out, r#"{"foo":"bar"}"#);
    }
}
