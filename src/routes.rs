use std::collections::HashMap;

use httparse::EMPTY_HEADER;
use parking_lot::RwLock;
use serde::Deserialize;
use serde::Serialize;

use crate::cache::CacheConfig;

/// Structured view of the incoming HTTP request, owned by the envelope.
/// Parsed once in Rust (cheaper than re-parsing in JS) and embedded in
/// the JSON envelope handed to the worker.
#[derive(Serialize)]
pub struct RequestEnvelope {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub cookies: HashMap<String, String>,
    pub search: HashMap<String, String>,
}

/// JSON envelope shipped across the tsfn boundary for each render call.
/// `kind: "render"` discriminates from the action variant; JS dispatcher
/// switches on this field. See ActionEnvelope below for the other variant.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub kind: &'static str,
    pub route_id: u32,
    pub path: &'a str,
    pub params: HashMap<&'a str, &'a str>,
    pub req: RequestEnvelope,
}

/// Mirrors RouteEnvelope but carries a string action_id (not numeric route_id)
/// and a content-type-aware body. `kind: "action"` discriminates from the
/// render variant. Exactly ONE of body_text / body_b64 is Some, decided by
/// the request's Content-Type header (see src/server.rs).
#[derive(Serialize)]
pub struct ActionEnvelope<'a> {
    pub kind: &'static str,
    pub action_id: &'a str,
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
    pub req: RequestEnvelope,
}

/// MCP JSON-RPC request envelope. `kind: "mcp"` discriminates from render
/// and action variants at the JS dispatcher; the JS-side `mcpBranch` then
/// parses `body_text` and switches on the JSON-RPC `method` field.
#[derive(Serialize)]
pub struct McpEnvelope<'a> {
    pub kind: &'static str,
    pub body_text: &'a str,
    pub req: RequestEnvelope,
}

pub fn build_mcp_envelope(
    method: &str,
    full_path: &str,
    body_text: &str,
    raw_request: &[u8],
) -> String {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, raw_request);
    let env = McpEnvelope {
        kind: "mcp",
        body_text,
        req,
    };
    serde_json::to_string(&env).unwrap()
}

/// SSE request envelope. `kind: "sse"` discriminates from render/action/mcp.
/// `conn_id` is the Rust-assigned monotonic id; the worker carries it back via
/// napi_sse_write / napi_sse_close / napi_sse_signal_open so Rust can correlate
/// chunks/lifecycle to the per-connection task.
#[derive(Serialize)]
pub struct SseEnvelope {
    pub kind: &'static str,
    pub conn_id: u64,
    pub req: RequestEnvelope,
}

pub fn build_sse_envelope(
    method: &str,
    full_path: &str,
    raw_request: &[u8],
    conn_id: u64,
) -> String {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, raw_request);
    let env = SseEnvelope {
        kind: "sse",
        conn_id,
        req,
    };
    serde_json::to_string(&env).unwrap()
}

/// WS upgrade request envelope. `kind: "ws"` discriminates from
/// render/action/mcp/sse. `conn_id` is the Rust-assigned monotonic id
/// (shared with SSE via the same NEXT_CONN_ID counter; separate
/// REGISTRY tables avoid collision). `client_subprotocols` is the
/// comma-split `Sec-WebSocket-Protocol` request value (trimmed); JS
/// picks the first match against `route.wsOptions.subprotocols` and
/// signals back via napi_ws_signal_open.
#[derive(Serialize)]
pub struct WsEnvelope {
    pub kind: &'static str,
    pub conn_id: u64,
    pub client_subprotocols: Vec<String>,
    pub req: RequestEnvelope,
}

pub fn build_ws_envelope(
    method: &str,
    full_path: &str,
    raw_request: &[u8],
    conn_id: u64,
    client_subprotocols: Vec<String>,
) -> String {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, raw_request);
    let env = WsEnvelope {
        kind: "ws",
        conn_id,
        client_subprotocols,
        req,
    };
    serde_json::to_string(&env).unwrap()
}

/// Build an ActionEnvelope JSON string. Mirrors `match_path` for the render
/// case. Caller has already validated the action_id charset and registry
/// membership; this function only assembles the envelope.
pub fn build_action_envelope(
    method: &str,
    full_path: &str,
    action_id: &str,
    content_type: &str,
    body_text: Option<&str>,
    body_b64: Option<&str>,
    raw_request: &[u8],
) -> String {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, raw_request);
    let env = ActionEnvelope {
        kind: "action",
        action_id,
        content_type,
        body_text,
        body_b64,
        req,
    };
    serde_json::to_string(&env).unwrap()
}

/// Outcome of a match against the radix tree.
pub enum MatchResult {
    Matched {
        route_id: u32,
        envelope_json: String,
    },
    NoMatch,
}

#[derive(Debug, Deserialize)]
pub struct RouteConfig {
    pub path: String,
    #[serde(default)]
    pub cache: Option<CacheConfig>,
}

#[derive(Default)]
pub struct RouteTable {
    inner: RwLock<matchit::Router<u32>>,
    cache_configs: RwLock<Vec<Option<CacheConfig>>>,
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
        for (idx, c) in configs.iter().enumerate() {
            router
                .insert(c.path.clone(), idx as u32)
                .map_err(|e| RouteInstallError::Insert {
                    pattern: c.path.clone(),
                    reason: e.to_string(),
                })?;
            caches.push(c.cache.clone());
        }
        *self.inner.write() = router;
        *self.cache_configs.write() = caches;
        Ok(configs.len() as u32)
    }

    pub fn cache_for(&self, route_id: u32) -> Option<CacheConfig> {
        self.cache_configs
            .read()
            .get(route_id as usize)
            .and_then(|c| c.clone())
    }

    pub fn match_path(&self, method: &str, full_path: &str, raw_request: &[u8]) -> MatchResult {
        let (path_only, query) = match full_path.split_once('?') {
            Some((p, q)) => (p, q),
            None => (full_path, ""),
        };
        let router = self.inner.read();
        match router.at(path_only) {
            Ok(matched) => {
                let mut params: HashMap<&str, &str> = HashMap::new();
                for (k, v) in matched.params.iter() {
                    params.insert(k, v);
                }
                let req = build_request_envelope(method, full_path, query, raw_request);
                let envelope = RouteEnvelope {
                    kind: "render",
                    route_id: *matched.value,
                    path: full_path,
                    params,
                    req,
                };
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                MatchResult::Matched {
                    route_id: *matched.value,
                    envelope_json,
                }
            }
            Err(_) => MatchResult::NoMatch,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RouteInstallError {
    #[error("invalid route pattern {pattern:?}: {reason}")]
    Insert { pattern: String, reason: String },
}

fn build_request_envelope(
    method: &str,
    full_path: &str,
    query: &str,
    raw_request: &[u8],
) -> RequestEnvelope {
    // 64-header ceiling matches src/server.rs::lookup_vary_headers — enough
    // for Apache-default-shaped requests; headers beyond are dropped silently.
    let mut headers_storage = [EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers_storage);
    let _ = req.parse(raw_request);

    let mut headers: HashMap<String, String> = HashMap::new();
    let mut cookies: HashMap<String, String> = HashMap::new();
    // Note: when a request carries multiple `Cookie:` headers (rare in
    // practice but legal per RFC 6265 §5.4), all cookies are merged into
    // `cookies`, but `headers["cookie"]` retains only the last raw line.
    // Apps falling back to the raw header string will miss earlier cookies.
    for h in req.headers.iter() {
        if h.name.is_empty() {
            continue;
        }
        let name_lower = h.name.to_ascii_lowercase();
        let value = std::str::from_utf8(h.value).unwrap_or("").to_string();
        if name_lower == "cookie" {
            for pair in value.split(';') {
                let trimmed = pair.trim();
                if let Some((k, v)) = trimmed.split_once('=') {
                    cookies.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
        }
        headers.insert(name_lower, value);
    }

    let mut search: HashMap<String, String> = HashMap::new();
    if !query.is_empty() {
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            match pair.split_once('=') {
                Some((k, v)) => {
                    search.insert(url_decode(k), url_decode(v));
                }
                None => {
                    search.insert(url_decode(pair), String::new());
                }
            }
        }
    }

    RequestEnvelope {
        method: method.to_string(),
        url: full_path.to_string(),
        headers,
        cookies,
        search,
    }
}

/// Minimal percent-decode for query-string keys/values. Decodes %xx and treats
/// `+` as space. Unrecognised escapes pass through unchanged.
fn url_decode(s: &str) -> String {
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
    String::from_utf8(out).unwrap_or_default()
}

/// Swap `"kind":"<old>"` → `"kind":"<new>"` in a JS-built JSON envelope
/// string. The envelope's field order is stable (the JS builder always
/// emits `kind` first), so a single targeted substring replace is correct
/// and cheaper than a parse-rewrite-serialise round-trip. Returns the input
/// unchanged if the `"kind":"render"` substring isn't found (defensive).
pub fn rewrite_envelope_kind(envelope_json: String, new_kind: &str) -> String {
    envelope_json.replacen(
        r#""kind":"render""#,
        &format!(r#""kind":"{}""#, new_kind),
        1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let raw = b"GET /x HTTP/1.1\r\nHost: x\r\nCookie: user=alice; sid=xyz\r\n\r\n";
        let env = build_request_envelope("GET", "/x", "", raw);
        assert_eq!(env.cookies.get("user").map(|s| s.as_str()), Some("alice"));
        assert_eq!(env.cookies.get("sid").map(|s| s.as_str()), Some("xyz"));
    }

    #[test]
    fn envelope_merges_cookies_across_multiple_cookie_headers() {
        // RFC 6265 §5.4 allows a single Cookie header per request, but
        // some proxies fold/split. Both cookies should appear in the map.
        let raw = b"GET /x HTTP/1.1\r\nHost: x\r\nCookie: a=1\r\nCookie: b=2\r\n\r\n";
        let env = build_request_envelope("GET", "/x", "", raw);
        assert_eq!(env.cookies.get("a").map(|s| s.as_str()), Some("1"));
        assert_eq!(env.cookies.get("b").map(|s| s.as_str()), Some("2"));
    }

    #[test]
    fn envelope_parses_search_with_key_only_and_empty_value() {
        let env = build_request_envelope(
            "GET",
            "/x?name=brust&flag&empty=",
            "name=brust&flag&empty=",
            b"",
        );
        assert_eq!(env.search.get("name").map(|s| s.as_str()), Some("brust"));
        assert_eq!(env.search.get("flag").map(|s| s.as_str()), Some(""));
        assert_eq!(env.search.get("empty").map(|s| s.as_str()), Some(""));
    }

    #[test]
    fn envelope_parses_search_with_percent_and_plus() {
        let env = build_request_envelope(
            "GET",
            "/x?greet=hello+world&unicode=%E2%9C%93",
            "greet=hello+world&unicode=%E2%9C%93",
            b"",
        );
        assert_eq!(
            env.search.get("greet").map(|s| s.as_str()),
            Some("hello world"),
        );
        assert_eq!(
            env.search.get("unicode").map(|s| s.as_str()),
            Some("\u{2713}"),
        );
    }

    #[test]
    fn envelope_empty_request_safe() {
        let env = build_request_envelope("GET", "/x", "", b"");
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
        };
        table.install_with_config(&[cfg]).unwrap();
        let raw = b"GET /foo HTTP/1.1\r\nHost: x\r\n\r\n";
        let result = table.match_path("GET", "/foo", raw);
        match result {
            MatchResult::Matched { envelope_json, .. } => {
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
        let json = build_action_envelope(
            "POST",
            "/_brust/action/createNote",
            "createNote",
            "application/json",
            Some(r#"["hello"]"#),
            None,
            b"POST /_brust/action/createNote HTTP/1.1\r\nHost: x\r\n\r\n",
        );
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
        let json = build_action_envelope(
            "POST",
            "/_brust/action/registerUser",
            "registerUser",
            "application/x-www-form-urlencoded",
            Some("name=Alice&age=30"),
            None,
            b"POST /_brust/action/registerUser HTTP/1.1\r\nHost: x\r\n\r\n",
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "action");
        assert_eq!(parsed["content_type"], "application/x-www-form-urlencoded");
        assert_eq!(parsed["body_text"], "name=Alice&age=30");
        assert!(parsed.get("body_b64").is_none());
    }

    #[test]
    fn action_envelope_multipart_path() {
        let json = build_action_envelope(
            "POST",
            "/_brust/action/uploadAvatar",
            "uploadAvatar",
            "multipart/form-data; boundary=abc",
            None,
            Some("LS1hYmMNCkNvbnRlbnQt"),
            b"POST /_brust/action/uploadAvatar HTTP/1.1\r\nHost: x\r\n\r\n",
        );
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
        let json = build_action_envelope(
            "POST",
            "/_brust/action/x",
            "x",
            "application/json",
            Some(r#"["hi \"there\"", 42]"#),
            None,
            b"",
        );
        let outer: serde_json::Value = serde_json::from_str(&json).unwrap();
        let inner: serde_json::Value =
            serde_json::from_str(outer["body_text"].as_str().unwrap()).unwrap();
        assert_eq!(inner[0], r#"hi "there""#);
        assert_eq!(inner[1], 42);
    }

    #[test]
    fn mcp_envelope_serialises_kind_mcp() {
        let json = build_mcp_envelope(
            "POST",
            "/_brust/mcp",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            b"POST /_brust/mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\r\n",
        );
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
        let json = build_mcp_envelope("POST", "/_brust/mcp", inner, b"");
        let outer: serde_json::Value = serde_json::from_str(&json).unwrap();
        let recovered: serde_json::Value =
            serde_json::from_str(outer["body_text"].as_str().unwrap()).unwrap();
        assert_eq!(recovered["params"]["arguments"]["text"], r#"hi "there""#);
    }

    #[test]
    fn sse_envelope_serialises_kind_sse_and_conn_id() {
        let json = build_sse_envelope(
            "GET",
            "/sse-counter",
            b"GET /sse-counter HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n",
            42u64,
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "sse");
        assert_eq!(parsed["conn_id"], 42);
        assert_eq!(parsed["req"]["method"], "GET");
        assert_eq!(parsed["req"]["url"], "/sse-counter");
    }

    #[test]
    fn sse_envelope_preserves_query_string() {
        let json = build_sse_envelope(
            "GET",
            "/events?topic=news",
            b"GET /events?topic=news HTTP/1.1\r\nHost: x\r\n\r\n",
            7u64,
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "sse");
        assert_eq!(parsed["conn_id"], 7);
        assert_eq!(parsed["req"]["url"], "/events?topic=news");
    }

    #[test]
    fn ws_envelope_serialises_kind_ws_and_conn_id() {
        let json = build_ws_envelope(
            "GET",
            "/ws/chat",
            b"GET /ws/chat HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
            42u64,
            vec!["chat.v2".to_string(), "chat.v1".to_string()],
        );
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
        let json = build_ws_envelope(
            "GET",
            "/ws/echo",
            b"GET /ws/echo HTTP/1.1\r\nHost: x\r\n\r\n",
            7u64,
            vec![],
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "ws");
        assert_eq!(parsed["conn_id"], 7);
        assert!(parsed["client_subprotocols"].as_array().unwrap().is_empty());
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
