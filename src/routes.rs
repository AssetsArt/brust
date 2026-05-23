use std::collections::HashMap;

use parking_lot::RwLock;
use serde::Deserialize;
use serde::Serialize;

use crate::cache::CacheConfig;

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
