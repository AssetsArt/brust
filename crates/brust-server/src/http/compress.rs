//! gzip compression (the pure part is `brust_core::compress`). Static assets (islands / css / public) negotiate through
//! `maybe_compress` at level 6 (docs/superpowers/specs/2026-06-03-static-compression-design.md);
//! pages call `gzip` with their own policy (pipeline: level 1, >= 16 KiB).
use std::sync::Arc;

pub use brust_core::compress::{accepts_gzip, gzip, is_compressible};
use moka::sync::Cache;
use once_cell::sync::Lazy;

/// Below this size the header + CPU overhead outweighs the saving.
const MIN_SIZE: usize = 1024;

/// Static assets: compressed once per path in prod, so the better ratio wins.
const STATIC_LEVEL: u32 = 6;

/// Process-global cache of gzipped bodies keyed by absolute asset path. Used in
/// PROD only — assets are immutable for the process lifetime, so a path key needs
/// no mtime. Dev compresses fresh (see `gzip_cached`) so a hot-reloaded file is
/// never served stale.
// 512 = approximate ENTRY count (not a byte budget); moka evicts via TinyLFU past
// it — far above any realistic island/css/public asset count.
static GZIP_CACHE: Lazy<Cache<String, Arc<Vec<u8>>>> = Lazy::new(|| Cache::new(512));

/// Prod: memoize per path. Dev: compress fresh (no cache → never stale on reload).
fn gzip_cached(path: &str, bytes: &[u8], dev: bool) -> Option<Vec<u8>> {
    if dev {
        return gzip(bytes, STATIC_LEVEL);
    }
    if let Some(hit) = GZIP_CACHE.get(path) {
        return Some((*hit).clone());
    }
    let out = gzip(bytes, STATIC_LEVEL)?;
    GZIP_CACHE.insert(path.to_string(), Arc::new(out.clone()));
    Some(out)
}

/// Negotiate + maybe compress a static asset. Returns the body to send and the
/// Content-Encoding (`Some("gzip")` or `None` for identity). Body passed by value;
/// on identity it is returned unchanged (no copy).
pub fn maybe_compress(
    accept_encoding: Option<&str>,
    content_type: &str,
    path: &str,
    bytes: Vec<u8>,
    dev: bool,
) -> (Vec<u8>, Option<&'static str>) {
    if bytes.len() >= MIN_SIZE
        && is_compressible(content_type)
        && accepts_gzip(accept_encoding)
        && let Some(gz) = gzip_cached(path, &bytes, dev)
    {
        return (gz, Some("gzip"));
    }
    (bytes, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maybe_compress_gates() {
        let js = b"x".repeat(2048);
        // happy path
        let (body, enc) = maybe_compress(
            Some("gzip"),
            "application/javascript",
            "/a.js",
            js.clone(),
            true,
        );
        assert_eq!(enc, Some("gzip"));
        assert!(body.len() < js.len());
        // no accept-encoding → identity
        let (body, enc) = maybe_compress(None, "application/javascript", "/a.js", js.clone(), true);
        assert_eq!(enc, None);
        assert_eq!(body, js);
        // incompressible type → identity
        let (_, enc) = maybe_compress(Some("gzip"), "image/png", "/a.png", js.clone(), true);
        assert_eq!(enc, None);
        // below MIN_SIZE → identity
        let small = b"x".repeat(100);
        let (_, enc) = maybe_compress(Some("gzip"), "text/css", "/a.css", small, true);
        assert_eq!(enc, None);
    }
}
