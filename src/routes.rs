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
