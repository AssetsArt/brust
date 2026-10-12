pub mod job_cache;
pub mod l1;
pub use brust_core::cache::{key_expr, stamp};

use std::sync::Arc;
use std::time::Duration;

use brust_core::cache::{CacheKey, CacheStats, JobKey, RenderedBody};
use brust_core::host::{JobStore, PageCache};
use brust_jinja::ctx::Node;

use job_cache::JobCache;
use l1::L1Cache;
use stamp::{InvalClock, ReadStamp};

/// The core pipeline's view of the native L1: each method forwards to the inherent one (which keeps
/// priority at native call sites).
impl PageCache for L1Cache {
    #[inline]
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self {
        L1Cache::with_clock(capacity, clock)
    }

    #[inline]
    fn get_with<R>(&self, key: &CacheKey, f: impl FnOnce(&Arc<RenderedBody>) -> R) -> Option<R> {
        L1Cache::get_with(self, key, f)
    }

    #[inline]
    fn insert(
        &self,
        key: CacheKey,
        body: Arc<RenderedBody>,
        ttl: Duration,
        tags: &[String],
        since: ReadStamp,
    ) -> bool {
        L1Cache::insert(self, key, body, ttl, tags, since)
    }

    #[inline]
    fn read_stamp(&self) -> ReadStamp {
        L1Cache::read_stamp(self)
    }

    #[inline]
    fn invalidate_tags(&self, tags: &[String]) -> usize {
        L1Cache::invalidate_tags(self, tags)
    }

    #[inline]
    fn invalidate_path(&self, method: &str, path: &str) -> usize {
        L1Cache::invalidate_path(self, method, path)
    }

    #[inline]
    fn stats(&self) -> CacheStats {
        L1Cache::stats(self)
    }
}

/// The core pipeline's view of the native job cache (forwards, as [`L1Cache`]'s).
impl JobStore for JobCache {
    #[inline]
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self {
        JobCache::with_clock(capacity, clock)
    }

    #[inline]
    fn get(&self, k: &JobKey) -> Option<Arc<Node>> {
        JobCache::get(self, k)
    }

    #[inline]
    fn insert(
        &self,
        k: JobKey,
        v: Arc<Node>,
        ttl: Option<Duration>,
        tags: &[String],
        user_key: Option<&str>,
        since: ReadStamp,
    ) -> bool {
        JobCache::insert(self, k, v, ttl, tags, user_key, since)
    }

    #[inline]
    fn read_stamp(&self) -> ReadStamp {
        JobCache::read_stamp(self)
    }

    #[inline]
    fn invalidate_tags(&self, tags: &[String]) -> usize {
        JobCache::invalidate_tags(self, tags)
    }

    #[inline]
    fn invalidate_user_key(&self, user_key: &str) -> usize {
        JobCache::invalidate_user_key(self, user_key)
    }

    #[inline]
    fn stats(&self) -> CacheStats {
        JobCache::stats(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::l1::build_cache_key;

    /// The core pipeline reaches the native caches only through `PageCache` / `JobStore`: each
    /// trait method is the inherent method (insert at a read stamp, hit, tag invalidation, miss).
    #[test]
    fn caches_forward_through_the_core_traits() {
        fn page<C: PageCache>(c: &C) {
            let k = build_cache_key("GET", "/p?b=2&a=1", String::new());
            let body = Arc::new(RenderedBody {
                status: 200,
                headers: http::HeaderMap::new(),
                html: bytes::Bytes::from_static(b"<p>"),
                gzip: std::sync::OnceLock::new(),
            });
            let tags = ["t".to_string()];
            assert!(c.insert(
                k.clone(),
                body,
                Duration::from_secs(60),
                &tags,
                c.read_stamp()
            ));
            assert_eq!(c.get_with(&k, |b| b.status), Some(200));
            assert_eq!(c.invalidate_tags(&tags), 1);
            assert_eq!(c.get_with(&k, |b| b.status), None);
            assert_eq!(c.invalidate_path("GET", "/p"), 0);
            assert_eq!(c.stats().hits, 1);
        }
        fn jobs<C: JobStore>(c: &C) {
            let k = JobKey("k:c/j/u".into());
            let tags = ["t".to_string()];
            let v = Arc::new(Node::str("v"));
            assert!(c.insert(k.clone(), v, None, &tags, Some("u"), c.read_stamp()));
            assert!(c.get(&k).is_some());
            assert_eq!(c.invalidate_tags(&tags), 1);
            assert!(c.get(&k).is_none());
            assert_eq!(c.invalidate_user_key("u"), 0);
            assert_eq!(c.stats().hits, 1);
        }
        let clock = Arc::new(InvalClock::default());
        page(&<L1Cache as PageCache>::with_clock(16, Arc::clone(&clock)));
        jobs(&<JobCache as JobStore>::with_clock(16, clock));
    }
}

/// The shared cache contract (`brust_core::cache::conformance`) against the native caches; the
/// same cases run against `brust_core::cache::local` in brust-core.
#[cfg(test)]
mod conformance {
    use brust_core::cache::conformance::{ConformJobs, ConformL1};

    use super::*;

    impl ConformL1 for L1Cache {
        fn clear(&self) -> usize {
            L1Cache::clear(self)
        }
        fn tag_slot(&self, t: &str) -> usize {
            L1Cache::tag_slot(self, t)
        }
        fn path_slot(&self, m: &str, p: &str) -> usize {
            L1Cache::path_slot(self, m, p)
        }
        fn tag_index_size(&self) -> usize {
            L1Cache::tag_index_size(self)
        }
        fn settle(&self) {
            self.run_pending();
        }
    }

    impl ConformJobs for JobCache {
        fn clear(&self) {
            JobCache::clear(self)
        }
        fn invalidate_key(&self, k: &JobKey) -> bool {
            JobCache::invalidate_key(self, k)
        }
        fn tag_slot(&self, t: &str) -> usize {
            JobCache::tag_slot(self, t)
        }
        fn key_slot(&self, u: &str) -> usize {
            JobCache::key_slot(self, u)
        }
        fn tag_index_size(&self) -> usize {
            JobCache::tag_index_size(self)
        }
        fn key_index_size(&self) -> usize {
            JobCache::key_index_size(self)
        }
        fn settle(&self) {
            self.run_pending();
        }
    }

    brust_core::page_cache_conformance!(<L1Cache as PageCache>::with_clock);
    brust_core::job_store_conformance!(<JobCache as JobStore>::with_clock);
    brust_core::shared_clock_conformance!(
        <L1Cache as PageCache>::with_clock,
        <JobCache as JobStore>::with_clock
    );
}
