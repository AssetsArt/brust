//! L2 page cache: a string-keyed store of framed single-chunk response payloads
//! (`[meta_len: u16 BE][meta JSON][body]`), with tag-group invalidation. Mirrors
//! island_cache::MokaStore (set-before-index ordering, lazy expiry) but stores
//! opaque payload bytes. Process-global in the addon singleton; shared across
//! the worker pool. See spec 2026-06-11-page-cache-two-modes-design.md.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use moka::sync::Cache;
use parking_lot::Mutex;

#[derive(Clone)]
struct CachedPage {
    payload: Vec<u8>,
    expires_at: Option<Instant>,
}

impl CachedPage {
    fn is_expired(&self) -> bool {
        matches!(self.expires_at, Some(t) if Instant::now() >= t)
    }
}

pub struct PageCache {
    cache: Cache<String, CachedPage>,
    tag_index: Mutex<HashMap<String, HashSet<String>>>,
}

impl PageCache {
    pub fn new(max_capacity: u64) -> Self {
        Self {
            cache: Cache::new(max_capacity.max(1)),
            tag_index: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let v = self.cache.get(key)?;
        if v.is_expired() {
            self.cache.invalidate(key);
            return None;
        }
        Some(v.payload)
    }

    pub fn set(&self, key: &str, tags: &[String], ttl: Option<Duration>, payload: Vec<u8>) {
        let expires_at = ttl.map(|d| Instant::now() + d);
        // Index tags BEFORE the moka insert (panic-race tolerance; see island_cache).
        // The tag index is not pruned when an entry lazy-expires via TTL — stale
        // keys (already evicted) are tolerated: invalidate_tags pops a possibly-
        // absent key (no-op), matching island_cache's documented invariant.
        if !tags.is_empty() {
            let mut idx = self.tag_index.lock();
            for tag in tags {
                idx.entry(tag.clone()).or_default().insert(key.to_string());
            }
        }
        self.cache.insert(
            key.to_string(),
            CachedPage {
                payload,
                expires_at,
            },
        );
    }

    pub fn invalidate_key(&self, key: &str) {
        self.cache.invalidate(key);
    }

    pub fn invalidate_tags(&self, tags: &[String]) {
        let keys: Vec<String> = {
            let mut idx = self.tag_index.lock();
            tags.iter()
                .filter_map(|t| idx.remove(t))
                .flatten()
                .collect()
        };
        for k in keys {
            self.cache.invalidate(&k);
        }
    }

    pub fn clear(&self) {
        // Wipe moka + the tag index atomically from the index's perspective
        // (a concurrent tagged `set` also locks tag_index, so it can't slip an
        // entry in between the two wipes). run_pending_tasks runs AFTER the lock
        // is dropped — holding the Mutex across moka's eviction callbacks risks
        // re-entrant deadlock if a callback ever calls back into the cache.
        {
            let mut idx = self.tag_index.lock();
            self.cache.invalidate_all();
            idx.clear();
        }
        self.cache.run_pending_tasks();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> PageCache {
        PageCache::new(100)
    }
    fn sync(s: &PageCache) {
        s.cache.run_pending_tasks();
    }

    #[test]
    fn set_then_get_returns_payload() {
        let s = store();
        s.set("k1", &[], None, b"PAYLOAD".to_vec());
        assert_eq!(s.get("k1").as_deref(), Some(&b"PAYLOAD"[..]));
    }
    #[test]
    fn missing_is_none() {
        assert!(store().get("nope").is_none());
    }
    #[test]
    fn zero_ttl_expires_immediately() {
        let s = store();
        s.set("k", &[], Some(Duration::ZERO), b"x".to_vec());
        assert!(s.get("k").is_none());
    }
    #[test]
    fn future_ttl_is_hit() {
        let s = store();
        s.set("k", &[], Some(Duration::from_secs(60)), b"x".to_vec());
        assert!(s.get("k").is_some());
    }
    #[test]
    fn invalidate_key_removes_one() {
        let s = store();
        s.set("a", &[], None, b"a".to_vec());
        s.set("b", &[], None, b"b".to_vec());
        s.invalidate_key("a");
        sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_some());
    }
    #[test]
    fn invalidate_tags_removes_group() {
        let s = store();
        s.set("a", &["user:1".into()], None, b"a".to_vec());
        s.set("b", &["user:1".into()], None, b"b".to_vec());
        s.set("c", &["user:2".into()], None, b"c".to_vec());
        s.invalidate_tags(&["user:1".into()]);
        sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_none());
        assert!(s.get("c").is_some());
    }
    #[test]
    fn clear_empties() {
        let s = store();
        s.set("a", &["t".into()], None, b"a".to_vec());
        s.clear();
        assert!(s.get("a").is_none());
    }
}
