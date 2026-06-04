//! Pure static-asset helpers, split out of `server/mod.rs` so the hyper service
//! module stays focused on request dispatch. Content-type detection, safe
//! filename validation, percent-decoding, and cache-control policy live here.

use crate::http;

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
/// Returns the raw HTTP/1.1 response bytes (status line + headers + body), so
/// the hyper service wraps it in a `BoxBody` via the response-from-raw helper.
pub(crate) fn static_asset_response(
    accept_encoding: &str,
    content_type: &str,
    path: &str,
    bytes: Vec<u8>,
    head: bool,
    dev: bool,
) -> Vec<u8> {
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
    // HEAD: same headers as the GET (incl. the content-length the GET body would
    // have produced — compression already applied) but no entity body.
    if head {
        http::build_response_head(200, content_type, &extra, body.len())
    } else {
        http::build_response(200, content_type, &extra, body)
    }
}

/// Percent-decode a URL **path** for static-asset manifest lookup. Identical to
/// `percent_decode` for `%XX` escapes, but a `+` is a LITERAL plus in a path
/// (only query strings map `+`→space). Manifest keys are raw filenames, so a
/// request like `/img/a%20b.png` must decode to `/img/a b.png` to match.
pub(crate) fn percent_decode_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Manifest lookup key for `path_no_query`: percent-decoded only when it actually
/// contains an escape, so the common no-escape path stays allocation-free.
pub(crate) fn asset_lookup_key(path_no_query: &str) -> std::borrow::Cow<'_, str> {
    if path_no_query.contains('%') {
        std::borrow::Cow::Owned(percent_decode_path(path_no_query))
    } else {
        std::borrow::Cow::Borrowed(path_no_query)
    }
}

/// Content-Type for a static public file, keyed on its file extension
/// (lowercased). Unknown/none → application/octet-stream.
pub(crate) fn content_type_for(file_path: &std::path::Path) -> &'static str {
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml; charset=utf-8",
        Some("xml") => "application/xml; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("ico") => "image/x-icon",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        Some("pdf") => "application/pdf",
        Some("wasm") => "application/wasm",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Reject filenames containing path separators, leading dots, or anything
/// outside `[A-Za-z0-9_.-]`. The filename MUST end in `.js`. This is the
/// only sanitization between the request line and `tokio::fs::read`.
pub(crate) fn is_safe_island_filename(name: &str) -> bool {
    if !name.ends_with(".js") {
        return false;
    }
    // Drop leading-dot files (.env.js, etc).
    if name.starts_with('.') {
        return false;
    }
    // `..` substring also rejects names like `a..b.js` — intentional belt
    // and suspenders against any traversal-shaped input.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Mirrors `is_safe_island_filename` but accepts `.css` extension. Keep the
/// two functions structurally identical — anything that's safe as an island
/// chunk filename is also safe as a CSS asset filename, modulo extension.
pub(crate) fn is_safe_css_filename(name: &str) -> bool {
    if !name.ends_with(".css") {
        return false;
    }
    if name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
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

    #[test]
    fn percent_decode_path_decodes_escapes_but_keeps_plus_literal() {
        // Static-asset path lookup: %XX → byte; but unlike query strings, a '+'
        // in a PATH is a literal '+', NOT a space. The manifest key is the raw
        // filename, so "/img/a%20b.png" must resolve to "/img/a b.png".
        assert_eq!(percent_decode_path("/img/a%20b.png"), "/img/a b.png");
        assert_eq!(percent_decode_path("/a+b.png"), "/a+b.png");
        // Lowercase hex + a non-ASCII byte sequence (é = C3 A9) round-trips.
        assert_eq!(percent_decode_path("/caf%c3%a9.png"), "/café.png");
        // A malformed escape is left verbatim (no panic, no data loss).
        assert_eq!(percent_decode_path("/a%2.png"), "/a%2.png");
        assert_eq!(percent_decode_path("/plain/path.css"), "/plain/path.css");
    }

    #[test]
    fn content_type_for_common_extensions() {
        use std::path::Path;
        assert_eq!(
            content_type_for(Path::new("/p/favicon.ico")),
            "image/x-icon"
        );
        assert_eq!(content_type_for(Path::new("/p/a.png")), "image/png");
        assert_eq!(
            content_type_for(Path::new("/p/a.svg")),
            "image/svg+xml; charset=utf-8"
        );
        assert_eq!(content_type_for(Path::new("/p/a.PNG")), "image/png");
        assert_eq!(content_type_for(Path::new("/p/a.woff2")), "font/woff2");
        assert_eq!(
            content_type_for(Path::new("/p/noext")),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for(Path::new("/p/a.weird")),
            "application/octet-stream"
        );
    }

    #[test]
    fn safe_filenames_pass() {
        assert!(is_safe_island_filename("Counter.js"));
        assert!(is_safe_island_filename("_react.js"));
        assert!(is_safe_island_filename("_jsx-runtime.js"));
        assert!(is_safe_island_filename("a.b.c.js"));
        assert!(is_safe_island_filename("Foo-Bar_123.js"));
    }

    #[test]
    fn unsafe_empty_rejected() {
        assert!(!is_safe_island_filename(""));
    }

    #[test]
    fn unsafe_no_extension_rejected() {
        assert!(!is_safe_island_filename("Counter"));
        assert!(!is_safe_island_filename("Counter.ts"));
    }

    #[test]
    fn unsafe_dot_prefix_rejected() {
        assert!(!is_safe_island_filename(".env.js"));
    }

    #[test]
    fn unsafe_traversal_rejected() {
        assert!(!is_safe_island_filename("../etc/passwd.js"));
        assert!(!is_safe_island_filename("..passwd.js"));
    }

    #[test]
    fn unsafe_separators_rejected() {
        assert!(!is_safe_island_filename("sub/file.js"));
        assert!(!is_safe_island_filename("sub\\file.js"));
    }

    #[test]
    fn unsafe_spaces_rejected() {
        assert!(!is_safe_island_filename("file with space.js"));
    }

    #[test]
    fn unsafe_percent_rejected() {
        assert!(!is_safe_island_filename("file%20.js"));
    }

    #[test]
    fn unsafe_non_ascii_rejected() {
        assert!(!is_safe_island_filename("évil.js"));
    }

    #[test]
    fn safe_css_filenames_pass() {
        assert!(is_safe_css_filename("app.css"));
        assert!(is_safe_css_filename("_a.css"));
        assert!(is_safe_css_filename("Foo-Bar_123.css"));
        assert!(is_safe_css_filename("a.b.css"));
    }

    #[test]
    fn unsafe_css_empty_rejected() {
        assert!(!is_safe_css_filename(""));
    }

    #[test]
    fn unsafe_css_wrong_ext_rejected() {
        assert!(!is_safe_css_filename("app.js"));
        assert!(!is_safe_css_filename("app"));
    }

    #[test]
    fn unsafe_css_dot_prefix_rejected() {
        assert!(!is_safe_css_filename(".env.css"));
    }

    #[test]
    fn unsafe_css_traversal_rejected() {
        assert!(!is_safe_css_filename("../etc/passwd.css"));
        assert!(!is_safe_css_filename("..passwd.css"));
    }

    #[test]
    fn unsafe_css_separators_rejected() {
        assert!(!is_safe_css_filename("sub/app.css"));
        assert!(!is_safe_css_filename("sub\\app.css"));
    }
}
