//! gzip compression for STATIC asset responses (islands / css / public).
//! Scope is static assets only — dynamic SSR / SAB / action / SSE paths are
//! untouched. See docs/superpowers/specs/2026-06-03-static-compression-design.md.
use std::io::Write;
use std::sync::Arc;

use flate2::Compression;
use flate2::write::GzEncoder;
use moka::sync::Cache;
use once_cell::sync::Lazy;

/// Below this size the header + CPU overhead outweighs the saving.
const MIN_SIZE: usize = 1024;

/// Process-global cache of gzipped bodies keyed by absolute asset path. Used in
/// PROD only — assets are immutable for the process lifetime, so a path key needs
/// no mtime. Dev compresses fresh (see `gzip_cached`) so a hot-reloaded file is
/// never served stale.
// 512 = approximate ENTRY count (not a byte budget); moka evicts via TinyLFU past
// it — far above any realistic island/css/public asset count.
static GZIP_CACHE: Lazy<Cache<String, Arc<Vec<u8>>>> = Lazy::new(|| Cache::new(512));

/// True if Accept-Encoding offers gzip with a non-zero q-value. Absent → false.
pub fn accepts_gzip(accept_encoding: Option<&str>) -> bool {
    let Some(ae) = accept_encoding else {
        return false;
    };
    for tok in ae.split(',') {
        let mut it = tok.split(';').map(str::trim);
        if it.next().unwrap_or("").eq_ignore_ascii_case("gzip") {
            let mut q = 1.0_f32;
            for p in it {
                if let Some(v) = p.strip_prefix("q=").or_else(|| p.strip_prefix("Q=")) {
                    // A malformed q-value disables this token (RFC 7231 §5.3.1),
                    // so fall back to 0.0 (reject), not 1.0.
                    q = v.trim().parse().unwrap_or(0.0);
                }
            }
            if q > 0.0 {
                return true;
            }
        }
    }
    false
}

/// Allowlist of compressible content types. Substring-safe: content types carry a
/// `; charset=utf-8` suffix, so match the media type before `;`.
pub fn is_compressible(content_type: &str) -> bool {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    ct.starts_with("text/")
        || matches!(
            ct,
            "application/javascript" | "application/json" | "application/xml" | "image/svg+xml"
        )
}

/// gzip `bytes` (level 6). `None` if the output is not smaller (incompressible).
pub fn gzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut enc = GzEncoder::new(
        Vec::with_capacity(bytes.len() / 2 + 32),
        Compression::new(6),
    );
    enc.write_all(bytes).ok()?;
    let out = enc.finish().ok()?;
    (out.len() < bytes.len()).then_some(out)
}

/// Prod: memoize per path. Dev: compress fresh (no cache → never stale on reload).
fn gzip_cached(path: &str, bytes: &[u8], dev: bool) -> Option<Vec<u8>> {
    if dev {
        return gzip(bytes);
    }
    if let Some(hit) = GZIP_CACHE.get(path) {
        return Some((*hit).clone());
    }
    let out = gzip(bytes)?;
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
    use flate2::read::GzDecoder;
    use std::io::Read;

    #[test]
    fn accepts_gzip_negotiation() {
        assert!(accepts_gzip(Some("gzip")));
        assert!(accepts_gzip(Some("gzip, br")));
        assert!(accepts_gzip(Some("br, gzip")));
        assert!(accepts_gzip(Some("gzip;q=1.0")));
        assert!(!accepts_gzip(Some("gzip;q=0")));
        assert!(!accepts_gzip(Some("gzip; q=0.0")));
        assert!(!accepts_gzip(Some("gzip;q=banana"))); // malformed q → reject
        assert!(!accepts_gzip(Some("identity")));
        assert!(!accepts_gzip(Some("br")));
        assert!(!accepts_gzip(None));
    }

    #[test]
    fn compressible_allowlist() {
        assert!(is_compressible("text/css; charset=utf-8"));
        assert!(is_compressible("application/javascript; charset=utf-8"));
        assert!(is_compressible("image/svg+xml"));
        assert!(is_compressible("application/json"));
        assert!(!is_compressible("image/png"));
        assert!(!is_compressible("font/woff2"));
        assert!(!is_compressible("application/gzip"));
    }

    #[test]
    fn gzip_round_trips() {
        let raw = b"console.log('hello');".repeat(200); // > MIN_SIZE, compressible
        let gz = gzip(&raw).expect("compressible input gzips smaller");
        assert!(gz.len() < raw.len());
        let mut dec = GzDecoder::new(&gz[..]);
        let mut back = Vec::new();
        dec.read_to_end(&mut back).unwrap();
        assert_eq!(back, raw);
    }

    #[test]
    fn gzip_none_when_not_smaller() {
        // 16 random-ish bytes don't compress below their own size.
        let raw: Vec<u8> = (0u8..16).collect();
        assert!(gzip(&raw).is_none());
    }

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
