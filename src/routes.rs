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
/// Worker JS deserializes this and uses `route_id` to pick the component.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub route_id: u32,
    pub path: &'a str,
    pub params: HashMap<&'a str, &'a str>,
    pub req: RequestEnvelope,
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
    pub fn install_with_config(
        &self,
        configs: &[RouteConfig],
    ) -> Result<u32, RouteInstallError> {
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
        self.cache_configs.read().get(route_id as usize).and_then(|c| c.clone())
    }

    pub fn match_path(
        &self,
        method: &str,
        full_path: &str,
        raw_request: &[u8],
    ) -> MatchResult {
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
                    search.insert(
                        url_decode(k),
                        url_decode(v),
                    );
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
}
