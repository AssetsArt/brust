//! Typed-Response builders shared by every host: canned errors, the generic
//! `(status, content-type, extra-headers, body)` shape and the HEAD rule. Moved from
//! `brust-server/src/server/body.rs`; the native host boxes the `Bytes` body once
//! (`brust_server::server::body::bytes_body`).
//!
//! The host owns framing: hyper recomputes `Content-Length` from a sized body and
//! manages `Connection`/keep-alive + `Date` itself, so these builders set only the
//! application headers (Content-Type, Cache-Control, Vary, Set-Cookie, …) and never
//! emit Content-Length / Transfer-Encoding / Connection.
//!
//! Native-host seam (`doc(hidden)`), not an API.

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode};

/// Framing headers hyper owns and recomputes itself: `Content-Length`,
/// `Transfer-Encoding`, `Connection`. The typed builders never emit these (and
/// the cache-HIT / SAB-meta paths strip them from stored bytes), so all three
/// skip-lists delegate here. Case-insensitive.
pub fn is_framing_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("content-length")
        || name.eq_ignore_ascii_case("transfer-encoding")
        || name.eq_ignore_ascii_case("connection")
}

/// Generic typed-Response builder: `(status, content-type, extra-headers, body)`.
/// Mirrors the old raw-byte `build_response` exactly minus the framing headers hyper owns
/// (Content-Length / Connection): sets `Content-Type`, then each extra header,
/// skipping the ones that would collide with the framing/content-type lines and
/// dropping any name/value carrying a CR/LF/NUL (the old builder's injection
/// guard). `Date` is added by hyper.
pub fn resp(
    status: u16,
    content_type: &str,
    extra_headers: &[(String, String)],
    body: Vec<u8>,
) -> Response<Bytes> {
    resp_with(
        status,
        header_map(content_type, extra_headers),
        Bytes::from(body),
    )
}

/// The header half of [`resp`]: `Content-Type`, then each extra header in
/// order, minus the framing / content-type names and any name/value carrying
/// a CR/LF/NUL. Built once per L1 entry so a HIT replays it without
/// re-validating.
pub fn header_map(content_type: &str, extra_headers: &[(String, String)]) -> HeaderMap {
    let mut hm = HeaderMap::new();
    // The page type is a static value: a HIT clones this map per request, and a static value carries no
    // refcount (a `from_str` value is shared `Bytes`, one contended RMW pair per HIT).
    let ct = match content_type {
        "text/html; charset=utf-8" => Ok(HeaderValue::from_static("text/html; charset=utf-8")),
        other => HeaderValue::from_str(other),
    };
    if let Ok(ct) = ct {
        hm.insert(http::header::CONTENT_TYPE, ct);
    }
    for (name, value) in extra_headers {
        // Skip names colliding with the framing / content-type lines the old
        // builder fixed: framing headers (Content-Length / Transfer-Encoding /
        // Connection) are hyper-owned so we never emit them; Content-Type is
        // already set above.
        if name.eq_ignore_ascii_case("content-type") || is_framing_header(name) {
            continue;
        }
        // CRLF / NUL injection guard (matches the byte-builder).
        if name.bytes().any(|b| b == b'\r' || b == b'\n' || b == b'\0')
            || value
                .bytes()
                .any(|b| b == b'\r' || b == b'\n' || b == b'\0')
        {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            hm.append(n, v);
        }
    }
    hm
}

/// A response from an already-built header map and a shared body (no copy).
pub fn resp_with(status: u16, headers: HeaderMap, body: Bytes) -> Response<Bytes> {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut r = Response::new(body);
    *r.status_mut() = status;
    *r.headers_mut() = headers;
    r
}

/// HEAD variant of [`resp`]: identical headers, no entity body, but carrying the
/// GET's true `Content-Length` (`content_length` = the entity size the matching
/// GET would return). RFC 7230 §3.3.2: a HEAD response reports the Content-Length
/// the GET would have, so CDNs/proxies can probe an asset's size via HEAD. Hyper
/// preserves an explicitly-set Content-Length on a HEAD response with an empty
/// body (it won't override it to 0).
pub fn resp_head(
    status: u16,
    content_type: &str,
    extra_headers: &[(String, String)],
    content_length: usize,
) -> Response<Bytes> {
    let mut response = resp(status, content_type, extra_headers, Vec::new());
    if let Ok(len) = HeaderValue::from_str(&content_length.to_string()) {
        response
            .headers_mut()
            .insert(http::header::CONTENT_LENGTH, len);
    }
    response
}

// ----- canned typed error responses (byte-identical bodies to the old http::error_* builders) -----

pub fn error_400() -> Response<Bytes> {
    resp(400, "text/plain", &[], b"bad request".to_vec())
}
pub fn error_404() -> Response<Bytes> {
    resp(404, "text/plain", &[], b"not found".to_vec())
}
/// RFC 9110 §15.5.6: a 405 lists the methods the target supports.
pub fn error_405() -> Response<Bytes> {
    resp(
        405,
        "text/plain",
        &[("Allow".into(), "GET, HEAD".into())],
        b"method not allowed".to_vec(),
    )
}
// kept for parity with body.rs @ d04718f
#[allow(dead_code)]
pub fn error_411() -> Response<Bytes> {
    resp(411, "text/plain", &[], b"length required".to_vec())
}
pub fn error_413() -> Response<Bytes> {
    resp(413, "text/plain", &[], b"payload too large".to_vec())
}
/// F87: a cross-site mutating action request, refused before its body is read.
pub fn error_403_cross_site(method: &str) -> Response<Bytes> {
    let detail = format!(
        "cross-site {method} to an action is rejected; set [actions] cross_site = \"allow\", or list the exact origin in [cors].origins (a wildcard does not count)"
    );
    let b = serde_json::json!({
        "type": "about:blank",
        "title": "CrossSiteRejected",
        "status": 403,
        "detail": detail,
    });
    resp(
        403,
        "application/problem+json",
        &[],
        b.to_string().into_bytes(),
    )
}
pub fn error_415() -> Response<Bytes> {
    resp(415, "text/plain", &[], b"unsupported media type".to_vec())
}
pub fn error_500() -> Response<Bytes> {
    resp(
        500,
        "text/plain",
        &[],
        b"500 Internal Server Error".to_vec(),
    )
}
pub fn error_503(msg: &str) -> Response<Bytes> {
    resp(503, "text/plain", &[], msg.as_bytes().to_vec())
}
pub fn error_504(msg: &str) -> Response<Bytes> {
    resp(504, "text/plain", &[], msg.as_bytes().to_vec())
}

/// Last-resort 500 for a builder whose header values fail validation (never, for
/// builder-produced values): `Content-Type: text/plain`, body `500 Internal Server Error`.
pub fn canned_500() -> Response<Bytes> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header("content-type", "text/plain")
        .body(Bytes::from_static(b"500 Internal Server Error"))
        .expect("static 500 response is always valid")
}

/// Case-insensitive single-header lookup as a trimmed `String`.
pub fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
}

/// RFC 9110 §9.3.2: a HEAD carries the GET's Content-Length. Page and action bodies
/// are fully buffered, so the length is exact.
pub fn head_only(resp: Response<Bytes>) -> Response<Bytes> {
    let (mut p, b) = resp.into_parts();
    p.headers
        .insert(http::header::CONTENT_LENGTH, b.len().into());
    Response::from_parts(p, Bytes::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_bytes(r: Response<Bytes>) -> Vec<u8> {
        r.into_body().to_vec()
    }

    #[test]
    fn resp_sets_content_type_and_extra_headers() {
        let extra = vec![("X-Foo".to_string(), "bar".to_string())];
        let r = resp(200, "text/plain", &extra, b"hi".to_vec());
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get("content-type").unwrap(), "text/plain");
        assert_eq!(r.headers().get("x-foo").unwrap(), "bar");
        // Framing headers are hyper-owned — never emitted here.
        assert!(r.headers().get("content-length").is_none());
        assert!(r.headers().get("connection").is_none());
        assert_eq!(body_bytes(r), b"hi");
    }

    #[test]
    fn resp_skips_colliding_and_injection_headers() {
        let extra = vec![
            ("Content-Type".to_string(), "evil".to_string()),
            ("CONTENT-LENGTH".to_string(), "0".to_string()),
            ("connection".to_string(), "close".to_string()),
            ("X-Evil".to_string(), "v\r\nSet-Cookie: x".to_string()),
        ];
        let r = resp(200, "text/plain", &extra, Vec::new());
        assert_eq!(r.headers().get("content-type").unwrap(), "text/plain");
        assert!(r.headers().get("x-evil").is_none());
        assert!(r.headers().get("set-cookie").is_none());
        assert!(r.headers().get("connection").is_none());
    }

    #[test]
    fn error_helpers_carry_expected_status_and_body() {
        let r = error_404();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_bytes(r), b"not found");

        let r = error_413();
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body_bytes(r), b"payload too large");
    }

    #[test]
    fn resp_head_carries_get_content_length_with_empty_body() {
        // RFC 7230 §3.3.2: a HEAD response reports the Content-Length the GET
        // would have, with no entity body. CDNs probe asset size via HEAD.
        let extra = vec![(
            "Cache-Control".to_string(),
            "public, max-age=3600".to_string(),
        )];
        let r = resp_head(200, "image/png", &extra, 70);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get("content-type").unwrap(), "image/png");
        assert_eq!(r.headers().get("content-length").unwrap(), "70");
        assert_eq!(
            r.headers().get("cache-control").unwrap(),
            "public, max-age=3600"
        );
        // No entity body on a HEAD.
        assert_eq!(body_bytes(r), b"");
    }
}
