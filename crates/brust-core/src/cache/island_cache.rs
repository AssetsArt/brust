use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use moka::sync::Cache;
use parking_lot::Mutex;

/// A frozen server-rendered island fragment. `html` is the renderToString
/// output; `props` is the entity-encoded JSON props attribute. Both are stored
/// together so a cache hit serves a self-consistent (html, props) pair —
/// serving cached html against live props would break client hydration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedIsland {
    pub html: String,
    pub props: String,
    /// Lazy expiry: `None` = never expires (invalidate-only). Checked on `get`,
    /// matching the house pattern in `cache.rs` (`CachedEntry::is_expired`).
    pub expires_at: Option<Instant>,
}

impl CachedIsland {
    fn is_expired(&self) -> bool {
        matches!(self.expires_at, Some(t) if Instant::now() >= t)
    }
}

/// Backend-swappable island fragment cache. `MokaStore` is the in-memory impl;
/// a `RedisStore` can replace it later without touching the runtime or NAPI.
pub trait CacheStore: Send + Sync {
    fn get(&self, key: &str) -> Option<CachedIsland>;
    fn set(&self, key: &str, tags: &[String], ttl: Option<Duration>, html: String, props: String);
    fn invalidate_key(&self, key: &str);
    fn invalidate_tags(&self, tags: &[String]);
    fn clear(&self);
}

pub struct MokaStore {
    cache: Cache<String, CachedIsland>,
    /// tag → set of keys carrying that tag. Enables group invalidation, which
    /// moka has no native support for. Stale entries (key already evicted) are
    /// tolerated: invalidate pops a possibly-absent key (no-op).
    tag_index: Mutex<HashMap<String, HashSet<String>>>,
}

impl MokaStore {
    pub fn new(max_capacity: u64) -> Self {
        // Clamp to ≥1: moka `Cache::new(0)` is a zero-capacity sink where every
        // insert is a no-op and every get a miss — a silent footgun. (cache.rs
        // uses NonZeroUsize for the same reason.)
        Self {
            cache: Cache::new(max_capacity.max(1)),
            tag_index: Mutex::new(HashMap::new()),
        }
    }
}

impl CacheStore for MokaStore {
    fn get(&self, key: &str) -> Option<CachedIsland> {
        let v = self.cache.get(key)?;
        if v.is_expired() {
            self.cache.invalidate(key);
            return None;
        }
        Some(v)
    }

    fn set(&self, key: &str, tags: &[String], ttl: Option<Duration>, html: String, props: String) {
        let expires_at = ttl.map(|d| Instant::now() + d);
        // Ordering is load-bearing: index the tags BEFORE the moka insert. The
        // reverse (insert then index) could leave a live, un-indexed entry if a
        // panic hit between the two. With this order the worst case is a benign
        // lost-invalidation (a concurrent invalidate_tags racing the insert just
        // misses the not-yet-present key — the entry then lazy-expires or is
        // dropped by invalidate_key). Safe because same-key renders are
        // byte-identical (spec invariant 2), so a stale serve is never *wrong*.
        if !tags.is_empty() {
            let mut idx = self.tag_index.lock();
            for tag in tags {
                idx.entry(tag.clone()).or_default().insert(key.to_string());
            }
        }
        self.cache.insert(
            key.to_string(),
            CachedIsland {
                html,
                props,
                expires_at,
            },
        );
    }

    fn invalidate_key(&self, key: &str) {
        self.cache.invalidate(key);
    }

    fn invalidate_tags(&self, tags: &[String]) {
        // Collect the affected keys under the lock, then DROP it before touching
        // moka — `cache.invalidate` does internal eviction-scheduling work, and
        // holding the tag_index Mutex across a large tag group would block every
        // concurrent tagged `set` for that whole duration.
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

    fn clear(&self) {
        // Hold tag_index across the whole clear so a concurrent tagged `set`
        // (which also locks tag_index) can't slip an entry in between the moka
        // wipe and the index wipe, leaving a live but un-indexed entry.
        let mut idx = self.tag_index.lock();
        self.cache.invalidate_all();
        self.cache.run_pending_tasks();
        idx.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MokaStore {
        MokaStore::new(100)
    }
    fn sync(s: &MokaStore) {
        s.cache.run_pending_tasks();
    }

    #[test]
    fn set_then_get_returns_frozen_pair() {
        let s = store();
        s.set(
            "k1",
            &[],
            None,
            "<b>1</b>".into(),
            "{&quot;n&quot;:1}".into(),
        );
        let got = s.get("k1").expect("hit");
        assert_eq!(got.html, "<b>1</b>");
        assert_eq!(got.props, "{&quot;n&quot;:1}");
    }

    #[test]
    fn missing_key_is_none() {
        assert!(store().get("nope").is_none());
    }

    #[test]
    fn zero_ttl_expires_immediately() {
        let s = store();
        s.set("k", &[], Some(Duration::ZERO), "h".into(), "p".into());
        assert!(s.get("k").is_none(), "ttl=0 entry must read as expired");
    }

    #[test]
    fn future_ttl_is_a_hit() {
        let s = store();
        s.set(
            "k",
            &[],
            Some(Duration::from_secs(60)),
            "h".into(),
            "p".into(),
        );
        assert!(s.get("k").is_some());
    }

    #[test]
    fn invalidate_key_removes_only_that_key() {
        let s = store();
        s.set("a", &[], None, "ha".into(), "pa".into());
        s.set("b", &[], None, "hb".into(), "pb".into());
        s.invalidate_key("a");
        sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_some());
    }

    #[test]
    fn invalidate_tags_removes_all_keys_in_group() {
        let s = store();
        s.set("a", &["products".into()], None, "ha".into(), "pa".into());
        s.set("b", &["products".into()], None, "hb".into(), "pb".into());
        s.set("c", &["other".into()], None, "hc".into(), "pc".into());
        s.invalidate_tags(&["products".into()]);
        sync(&s);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_none());
        assert!(s.get("c").is_some(), "untagged group survives");
    }

    #[test]
    fn clear_empties_everything() {
        let s = store();
        s.set("a", &["t".into()], None, "h".into(), "p".into());
        s.clear();
        assert!(s.get("a").is_none());
    }

    #[test]
    fn trait_object_is_usable() {
        let s: Box<dyn CacheStore> = Box::new(store());
        s.set("k", &[], None, "h".into(), "p".into());
        assert!(s.get("k").is_some());
    }
}
