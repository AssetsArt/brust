//! gzip negotiation and compression, host-agnostic. Pages call `gzip` with their own policy
//! (pipeline: level 1, >= 16 KiB); the native host's static assets memoize it per path
//! (`brust_server::http::compress::maybe_compress`). Behind the default `gzip` feature.
#[cfg(feature = "gzip")]
use std::io::Write;

#[cfg(feature = "gzip")]
use flate2::Compression;
#[cfg(feature = "gzip")]
use flate2::write::GzEncoder;

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

/// gzip `bytes` at `level` (0-9). `None` if the output is not smaller
/// (incompressible).
#[cfg(feature = "gzip")]
pub fn gzip(bytes: &[u8], level: u32) -> Option<Vec<u8>> {
    let mut enc = GzEncoder::new(
        Vec::with_capacity(bytes.len() / 2 + 32),
        Compression::new(level),
    );
    enc.write_all(bytes).ok()?;
    let out = enc.finish().ok()?;
    (out.len() < bytes.len()).then_some(out)
}

/// Without the `gzip` feature nothing is compressed: every body is served identity.
#[cfg(not(feature = "gzip"))]
pub fn gzip(_bytes: &[u8], _level: u32) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "gzip")]
    use flate2::read::GzDecoder;
    #[cfg(feature = "gzip")]
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

    #[cfg(feature = "gzip")]
    #[test]
    fn gzip_round_trips() {
        let raw = b"console.log('hello');".repeat(200); // > MIN_SIZE, compressible
        let gz = gzip(&raw, 6).expect("compressible input gzips smaller");
        assert!(gz.len() < raw.len());
        let mut dec = GzDecoder::new(&gz[..]);
        let mut back = Vec::new();
        dec.read_to_end(&mut back).unwrap();
        assert_eq!(back, raw);
    }

    #[cfg(feature = "gzip")]
    #[test]
    fn gzip_none_when_not_smaller() {
        // 16 random-ish bytes don't compress below their own size.
        let raw: Vec<u8> = (0u8..16).collect();
        assert!(gzip(&raw, 6).is_none());
    }
}
