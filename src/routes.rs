use std::collections::HashMap;

use parking_lot::RwLock;
use serde::Serialize;

/// JSON envelope shipped across the tsfn boundary for each render call.
/// Worker JS deserializes this and uses `route_id` to pick the component.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub route_id: u32,
    pub path: &'a str,
    pub params: HashMap<&'a str, &'a str>,
}

/// Outcome of a match against the radix tree.
pub enum MatchResult {
    Matched {
        #[allow(dead_code)] // Carried for future Rust-side middleware/logging; JS reads it via envelope_json.
        route_id: u32,
        envelope_json: String,
    },
    NoMatch,
}

#[derive(Default)]
pub struct RouteTable {
    inner: RwLock<matchit::Router<u32>>,
}

impl RouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the route set. Patterns are inserted in array order; the array
    /// index becomes the `route_id` value matched against by the worker
    /// dispatcher. Called once during boot.
    pub fn install(&self, patterns: &[String]) -> Result<u32, RouteInstallError> {
        let mut router = matchit::Router::new();
        for (idx, pattern) in patterns.iter().enumerate() {
            router
                .insert(pattern.clone(), idx as u32)
                .map_err(|e| RouteInstallError::Insert {
                    pattern: pattern.clone(),
                    reason: e.to_string(),
                })?;
        }
        *self.inner.write() = router;
        Ok(patterns.len() as u32)
    }

    /// Match a request path. Returns a fully serialized JSON envelope ready to
    /// hand to the tsfn, or `NoMatch`.
    pub fn match_path(&self, path: &str) -> MatchResult {
        let router = self.inner.read();
        match router.at(path) {
            Ok(matched) => {
                let mut params: HashMap<&str, &str> = HashMap::new();
                for (k, v) in matched.params.iter() {
                    params.insert(k, v);
                }
                let envelope = RouteEnvelope {
                    route_id: *matched.value,
                    path,
                    params,
                };
                // serde_json::to_string cannot fail in practice — no IO, all
                // values are valid &str. Unwrap is safe.
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
