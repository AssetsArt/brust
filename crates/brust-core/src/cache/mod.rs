//! Caches: the SSR response cache (`response_cache`) and the island fragment
//! cache (`island_cache`).

pub mod island_cache;
pub mod key_expr;
pub mod page_cache;
pub mod response_cache;

pub use island_cache::{CacheStore, CachedIsland};
// MokaStore (the concrete backend) is intentionally NOT re-exported: the binding
// only sees the `CacheStore` trait. `AppState::new` constructs it via the full
// `cache::island_cache::MokaStore` path.
pub use response_cache::{
    BypassSpec, CacheConfig, CacheKey, CacheStats, CachedEntry, ResponseCache,
};
