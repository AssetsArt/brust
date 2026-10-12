//! Pure static-asset helpers, split out of `server/mod.rs` so the hyper service
//! module stays focused on request dispatch. Content-type detection, safe
//! filename validation, percent-decoding, and cache-control policy live here.

use brust_core::body::{resp, resp_head};
use bytes::Bytes;

/// `Cache-Control` for static assets (`/_brust/islands/*`, `/_brust/css/*`).
/// Dev → `no-store`: chunk URLs are unhashed (`Counter.js`), so a hot-reload
/// rebuild would otherwise be masked by the browser cache. Prod → cacheable.
pub(crate) fn asset_cache_control(dev: bool) -> &'static str {
    if dev {
        "no-store"
    } else {
        "public, max-age=3600"
    }
}

/// Build a static-asset response: negotiate gzip, set Cache-Control + Vary, and
/// Content-Encoding when compressed. `path` is the on-disk path (cache key).
/// `accept_encoding` is the request's `Accept-Encoding` header value (or "").
/// Returns a typed `http::Response<Bytes>` built directly (hyper owns
/// Content-Length / Connection / Date).
pub(crate) fn static_asset_response(
    accept_encoding: &str,
    content_type: &str,
    path: &str,
    bytes: Vec<u8>,
    head: bool,
    dev: bool,
) -> http::Response<Bytes> {
    let (body, encoding) = crate::http::compress::maybe_compress(
        Some(accept_encoding),
        content_type,
        path,
        bytes,
        dev,
    );
    let mut extra: Vec<(String, String)> = vec![(
        "Cache-Control".to_string(),
        asset_cache_control(dev).to_string(),
    )];
    // Vary only matters for compression-eligible types — a non-compressible asset
    // (png/woff2/…) never varies by Accept-Encoding, so omitting it keeps CDN/proxy
    // cache variants minimal.
    if crate::http::compress::is_compressible(content_type) {
        extra.push(("Vary".to_string(), "Accept-Encoding".to_string()));
    }
    if let Some(enc) = encoding {
        extra.push(("Content-Encoding".to_string(), enc.to_string()));
    }
    // HEAD: same headers as the GET (Cache-Control / Vary / Content-Encoding)
    // but no entity body. RFC 7230 §3.3.2 — report the GET's true Content-Length
    // (`body.len()`, the possibly-compressed entity size) so CDNs can probe size
    // via HEAD. `body` is dropped; only its length is carried.
    if head {
        resp_head(200, content_type, &extra, body.len())
    } else {
        resp(200, content_type, &extra, body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_assets_are_no_store_prod_cacheable() {
        // Dev hot reload rebuilds unhashed chunk URLs (Counter.js); a cacheable
        // header would mask the rebuild in the browser. Dev must be no-store.
        assert_eq!(asset_cache_control(true), "no-store");
        assert_eq!(asset_cache_control(false), "public, max-age=3600");
    }
}
