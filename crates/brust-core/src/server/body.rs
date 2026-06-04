//! Response-body plumbing + typed-Response builders for the hyper service.
//!
//! The hyper service builds `http::Response<ResponseBody>` values directly.
//! These helpers centralise the body wrappers (`full_body`, `empty_body`,
//! `channel_body`) and the small set of typed-Response constructors that
//! replace the old raw-byte builders: canned errors, the generic
//! `(status, content-type, extra-headers, body)` shape, the SAB fast-lane meta
//! response, and the static-asset response.
//!
//! Hyper owns framing: it recomputes `Content-Length` from a sized body and
//! manages `Connection`/keep-alive + `Date` itself, so these builders set only
//! the application headers (Content-Type, Cache-Control, Vary, Set-Cookie, …)
//! and never emit Content-Length / Transfer-Encoding / Connection — matching
//! the pre-hyper wire output (those were stripped by the old shim too).

use std::convert::Infallible;
use std::io;

use bytes::Bytes;
use http::{HeaderName, HeaderValue, Response, StatusCode};
use http_body::Frame;
use http_body_util::{BodyExt, Full, StreamBody, combinators::BoxBody};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;

/// Boxed response body used across the hyper service. Error type is
/// `std::io::Error` so streaming bodies can surface I/O failures.
pub(crate) type ResponseBody = BoxBody<Bytes, io::Error>;

/// A fixed (already-buffered) body. `Full` never errors, so we map its
/// `Infallible` error into `io::Error` to fit the `ResponseBody` alias.
pub(crate) fn full_body(v: Vec<u8>) -> ResponseBody {
    Full::new(Bytes::from(v))
        .map_err(|never: Infallible| match never {})
        .boxed()
}

/// An empty body (101 upgrades, etc).
pub(crate) fn empty_body() -> ResponseBody {
    full_body(Vec::new())
}

/// A streaming body fed by an mpsc `Sender<Bytes>`. Each received chunk is
/// emitted as a data frame; the body completes when the sender drops.
pub(crate) fn channel_body(rx: tokio::sync::mpsc::Receiver<Bytes>) -> ResponseBody {
    StreamBody::new(ReceiverStream::new(rx).map(|b| Ok::<_, io::Error>(Frame::data(b)))).boxed()
}

/// Last-resort 500, typed directly. Used as the `unwrap_or_else` fallback for
/// any builder whose header values fail validation (should not happen for
/// builder-produced values). Headers identical to `error_500()`'s body shape:
/// `Content-Type: text/plain`, body `500 Internal Server Error`.
pub(crate) fn canned_500() -> Response<ResponseBody> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header("content-type", "text/plain")
        .body(full_body(b"500 Internal Server Error".to_vec()))
        .expect("static 500 response is always valid")
}

/// Framing headers hyper owns and recomputes itself: `Content-Length`,
/// `Transfer-Encoding`, `Connection`. The typed builders never emit these (and
/// the cache-HIT / SAB-meta paths strip them from stored bytes), so all three
/// skip-lists delegate here. Case-insensitive.
pub(crate) fn is_framing_header(name: &str) -> bool {
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
pub(crate) fn resp(
    status: u16,
    content_type: &str,
    extra_headers: &[(String, String)],
    body: Vec<u8>,
) -> Response<ResponseBody> {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder().status(status);
    if let Some(hm) = builder.headers_mut()
        && let Ok(ct) = HeaderValue::from_str(content_type)
    {
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
        if let Some(hm) = builder.headers_mut()
            && let (Ok(n), Ok(v)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            )
        {
            hm.append(n, v);
        }
    }
    builder
        .body(full_body(body))
        .unwrap_or_else(|_| canned_500())
}

/// HEAD variant of [`resp`]: identical headers, no entity body, but carrying the
/// GET's true `Content-Length` (`content_length` = the entity size the matching
/// GET would return). RFC 7230 §3.3.2: a HEAD response reports the Content-Length
/// the GET would have, so CDNs/proxies can probe an asset's size via HEAD. Hyper
/// preserves an explicitly-set Content-Length on a HEAD response with an empty
/// body (it won't override it to 0).
pub(crate) fn resp_head(
    status: u16,
    content_type: &str,
    extra_headers: &[(String, String)],
    content_length: usize,
) -> Response<ResponseBody> {
    let mut response = resp(status, content_type, extra_headers, Vec::new());
    if let Ok(len) = HeaderValue::from_str(&content_length.to_string()) {
        response
            .headers_mut()
            .insert(http::header::CONTENT_LENGTH, len);
    }
    response
}

/// Build a typed Response from the framed HTTP/1.1 bytes the cache stores
/// (`build_single_response_bytes` output: `HTTP/1.1 <code> <reason>\r\n
/// <headers>\r\n\r\n<body>`). Parses the status line + headers by hand (no
/// httparse) and strips the framing headers hyper owns. Used ONLY on a cache
/// HIT — the stored bytes are always builder-produced, so the format is exact.
pub(crate) fn response_from_framed_bytes(raw: Vec<u8>) -> Response<ResponseBody> {
    // first \r\n\r\n = header/body boundary; build_single_response_bytes always emits headers first
    let Some(sep) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
        return canned_500();
    };
    let head = &raw[..sep];
    let body = raw[sep + 4..].to_vec();

    let mut lines = head.split(|&b| b == b'\n');
    // Status line: "HTTP/1.1 <code> <reason>\r" — pull the 3-digit code.
    let Some(status_line) = lines.next() else {
        return canned_500();
    };
    let status_line = std::str::from_utf8(status_line).unwrap_or("").trim_end();
    // Self-generated bytes (always builder-produced), but if the status line
    // can't be parsed don't serve a cached error BODY under a false 200 — fall
    // back to the 500 sentinel.
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .and_then(|c| StatusCode::from_u16(c).ok())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    let mut builder = Response::builder().status(status);
    for line in lines {
        let line = match std::str::from_utf8(line) {
            Ok(l) => l.trim_end_matches('\r'),
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if is_framing_header(name) {
            continue;
        }
        // http::HeaderValue::from_str rejects CR/LF/NUL — injection guard delegated to the http crate
        if let Some(hm) = builder.headers_mut()
            && let (Ok(n), Ok(v)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            )
        {
            hm.append(n, v);
        }
    }
    builder
        .body(full_body(body))
        .unwrap_or_else(|_| canned_500())
}

// ----- canned typed error responses (byte-identical bodies to the old http::error_* builders) -----

pub(crate) fn error_400() -> Response<ResponseBody> {
    resp(400, "text/plain", &[], b"bad request".to_vec())
}
pub(crate) fn error_404() -> Response<ResponseBody> {
    resp(404, "text/plain", &[], b"not found".to_vec())
}
pub(crate) fn error_405() -> Response<ResponseBody> {
    resp(405, "text/plain", &[], b"method not allowed".to_vec())
}
pub(crate) fn error_411() -> Response<ResponseBody> {
    resp(411, "text/plain", &[], b"length required".to_vec())
}
pub(crate) fn error_413() -> Response<ResponseBody> {
    resp(413, "text/plain", &[], b"payload too large".to_vec())
}
pub(crate) fn error_415() -> Response<ResponseBody> {
    resp(415, "text/plain", &[], b"unsupported media type".to_vec())
}
pub(crate) fn error_500() -> Response<ResponseBody> {
    resp(
        500,
        "text/plain",
        &[],
        b"500 Internal Server Error".to_vec(),
    )
}
pub(crate) fn error_503(msg: &str) -> Response<ResponseBody> {
    resp(503, "text/plain", &[], msg.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body_bytes(resp: Response<ResponseBody>) -> Vec<u8> {
        resp.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }

    #[tokio::test]
    async fn resp_sets_content_type_and_extra_headers() {
        let extra = vec![("X-Foo".to_string(), "bar".to_string())];
        let r = resp(200, "text/plain", &extra, b"hi".to_vec());
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get("content-type").unwrap(), "text/plain");
        assert_eq!(r.headers().get("x-foo").unwrap(), "bar");
        // Framing headers are hyper-owned — never emitted here.
        assert!(r.headers().get("content-length").is_none());
        assert!(r.headers().get("connection").is_none());
        assert_eq!(body_bytes(r).await, b"hi");
    }

    #[tokio::test]
    async fn resp_skips_colliding_and_injection_headers() {
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

    #[tokio::test]
    async fn error_helpers_carry_expected_status_and_body() {
        let r = error_404();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_bytes(r).await, b"not found");

        let r = error_413();
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body_bytes(r).await, b"payload too large");
    }

    #[tokio::test]
    async fn resp_head_carries_get_content_length_with_empty_body() {
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
        assert_eq!(body_bytes(r).await, b"");
    }

    #[tokio::test]
    async fn response_from_framed_bytes_status_line_without_reason_phrase() {
        // A status line carrying only "HTTP/1.1 200" (no reason phrase) still
        // parses the code from the 2nd whitespace-split token → 200.
        let raw = b"HTTP/1.1 200\r\nContent-Type: text/plain\r\n\r\nok".to_vec();
        let r = response_from_framed_bytes(raw);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(body_bytes(r).await, b"ok");
    }

    #[tokio::test]
    async fn response_from_framed_bytes_unparseable_status_is_500() {
        // No numeric code on the status line → 500 sentinel, never a false 200.
        let raw = b"HTTP/1.1\r\nContent-Type: text/plain\r\n\r\noops".to_vec();
        let r = response_from_framed_bytes(raw);
        assert_eq!(r.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn response_from_framed_bytes_round_trips() {
        let raw =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 6\r\nConnection: keep-alive\r\nX-Foo: bar\r\n\r\n<html>".to_vec();
        let r = response_from_framed_bytes(raw);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(
            r.headers().get("content-type").unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(r.headers().get("x-foo").unwrap(), "bar");
        // Framing headers stripped.
        assert!(r.headers().get("content-length").is_none());
        assert!(r.headers().get("connection").is_none());
        assert_eq!(body_bytes(r).await, b"<html>");
    }
}
