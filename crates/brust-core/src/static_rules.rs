//! Static-file path rules every host applies before it touches storage: percent-decoding,
//! the `/_brust/` + `/public/` admission rule, content types and the content-hash test.
//! Moved from `brust-server/src/server/static_assets.rs` and `pipeline.rs`.
//! `content_type_for` is the native-host seam (`doc(hidden)`), not an API; the rest are
//! crate-private.

use crate::host::StaticRoot;

/// Immutable `Cache-Control` for content-hashed static files.
pub(crate) const IMMUTABLE: &str = "public, max-age=31536000, immutable";

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
pub fn content_type_for(file_path: &std::path::Path) -> &'static str {
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

/// L19 (R19.2, research C5): a font or image a stylesheet references by a relative `url()`, emitted
/// next to it as `client/<name>-<hash>.<ext>`. Same name rule as the chunks; only these extensions.
pub(crate) fn is_safe_client_asset_filename(name: &str) -> bool {
    const EXT: &[&str] = &[
        ".woff2", ".woff", ".ttf", ".otf", ".eot", ".png", ".jpg", ".jpeg", ".gif", ".webp",
        ".avif", ".svg", ".ico",
    ];
    if !EXT.iter().any(|e| name.ends_with(e)) {
        return false;
    }
    if name.starts_with('.') || name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Validate a static `rel` path (already percent-decoded). Every segment is
/// non-empty, does not start with `.` (so no `.`/`..`/dotfiles) and holds only
/// `[A-Za-z0-9_.-]`. Under `/_brust/` only `client/<file>.js|.css` (and the fonts and images a
/// stylesheet references, L19) is served:
/// the dist root also holds `manifest.json`, `jobs.js` (server-side) and
/// `jinja/`, none of which may leave the server.
pub(crate) fn safe_rel(rel: &str, root: StaticRoot) -> Option<&str> {
    let segs: Vec<&str> = rel.split('/').collect();
    let seg_ok = |s: &&str| {
        !s.is_empty()
            && !s.starts_with('.')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    if !segs.iter().all(seg_ok) {
        return None;
    }
    if root == StaticRoot::Brust {
        let [dir, file] = segs.as_slice() else {
            return None;
        };
        if *dir != "client"
            || !(is_safe_island_filename(file)
                || is_safe_css_filename(file)
                || is_safe_client_asset_filename(file))
        {
            return None;
        }
    }
    Some(rel)
}

/// `<stem>` ends in `-<hex6+>` (lowercase) holding at least one digit: a
/// content-hashed file name. The digit rule keeps English words spelt in hex
/// letters (`brand-facade.css`, `-decade`) from being marked immutable.
pub(crate) fn is_hashed(file: &std::path::Path) -> bool {
    let Some(stem) = file.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    match stem.rsplit_once('-') {
        Some((_, h)) => {
            h.len() >= 6
                && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                && h.bytes().any(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_names_need_six_lowercase_hex() {
        use std::path::Path as P;
        assert!(is_hashed(P::new("client/detailPage_c3-1a2b3c.js")));
        assert!(!is_hashed(P::new("client/runtime-8b1c.js")));
        assert!(!is_hashed(P::new("client/x-1A2B3C.js")));
        assert!(!is_hashed(P::new("client/react-19.2.0.js")));
        // Hex-letter words are not hashes: the suffix needs a digit.
        assert!(!is_hashed(P::new("public/brand-facade.css")));
        assert!(!is_hashed(P::new("public/decade-abcdef.css")));
        assert!(is_hashed(P::new("public/logo-abcde1.svg")));
    }

    #[test]
    fn static_rel_rule() {
        let b = StaticRoot::Brust;
        assert_eq!(safe_rel("client/a-1.js", b), Some("client/a-1.js"));
        assert_eq!(safe_rel("client/a.css", b), Some("client/a.css"));
        for bad in [
            "manifest.json",
            "jobs.js",
            "jinja/x.jinja",
            "client/../manifest.json",
            "client/.x.js",
            "client/x.json",
            "client//x.js",
            "client/sub/x.js",
            "",
        ] {
            assert_eq!(safe_rel(bad, b), None, "{bad}");
        }
        // L19: the fonts and images a stylesheet references, only by extension.
        for ok in [
            "client/inter-1a2b3c4d5e.woff2",
            "client/bg-0a1b2c3d4e.png",
            "client/i.svg",
        ] {
            assert_eq!(safe_rel(ok, b), Some(ok), "{ok}");
        }
        for bad in [
            "client/x.html",
            "client/x.wasm",
            "client/.x.woff2",
            "client/a..b.png",
        ] {
            assert_eq!(safe_rel(bad, b), None, "{bad}");
        }
        let p = StaticRoot::Public;
        assert_eq!(safe_rel("img/a.png", p), Some("img/a.png"));
        for bad in ["../manifest.json", "", "a/", "/a", "a\\b", ".env", "a b"] {
            assert_eq!(safe_rel(bad, p), None, "{bad}");
        }
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
