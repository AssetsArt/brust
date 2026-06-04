//! Response-body plumbing for the hyper service.
//!
//! The pre-hyper server emitted complete HTTP/1.1 response BYTES (status line +
//! headers + body) from a family of builders (`http::build_response`, the
//! `error_4xx` helpers, `render::stream::build_single_response_bytes`,
//! `build_chunked_response_head`, `static_assets::static_asset_response`). To
//! preserve every status code / header / body byte-for-byte while serving over
//! hyper, we keep those builders unchanged and convert their raw output back
//! into a typed `http::Response<BoxBody>` here via [`raw_http_to_response`].
//!
//! Hyper owns framing: it recomputes `Content-Length` from a `Full` body and
//! manages `Connection`/keep-alive itself, so we strip the hop-by-hop and
//! length/encoding headers from the parsed raw response to avoid conflicts.

use std::convert::Infallible;
use std::io;

use bytes::Bytes;
use http::{Response, StatusCode};
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

/// Parse a complete raw HTTP/1.1 response (`status line + headers + \r\n\r\n +
/// body`) — as produced by the existing byte-builders — into a typed
/// `Response<ResponseBody>`. Strips `Content-Length`, `Transfer-Encoding`, and
/// `Connection` because hyper recomputes/owns those. Any header the builder
/// emitted (Content-Type, Cache-Control, Vary, Content-Encoding, X-*, …) is
/// carried through verbatim so wire output matches the old server.
pub(crate) fn raw_http_to_response(raw: Vec<u8>) -> Response<ResponseBody> {
    // Split headers from body at the first CRLFCRLF.
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
    let (head, body): (&[u8], Vec<u8>) = match split {
        Some(p) => (&raw[..p], raw[p..].to_vec()),
        // Builders always emit a header terminator; fall back to a 500 shell.
        None => return canned_500(),
    };

    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut resp = httparse::Response::new(&mut headers);
    if resp.parse(head).is_err() {
        return canned_500();
    }
    let status = resp
        .code
        .and_then(|c| StatusCode::from_u16(c).ok())
        .unwrap_or(StatusCode::OK);

    let mut builder = Response::builder().status(status);
    for h in resp.headers.iter() {
        if h.name.is_empty() {
            continue;
        }
        // Hyper manages these — emitting them ourselves double-counts or fights
        // its connection management.
        if h.name.eq_ignore_ascii_case("content-length")
            || h.name.eq_ignore_ascii_case("transfer-encoding")
            || h.name.eq_ignore_ascii_case("connection")
        {
            continue;
        }
        builder = builder.header(h.name, h.value);
    }

    builder
        .body(full_body(body))
        .unwrap_or_else(|_| canned_500())
}

/// Last-resort 500 used when a raw response can't be parsed (should not happen
/// for builder-produced bytes). Typed directly to avoid recursion.
fn canned_500() -> Response<ResponseBody> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header("content-type", "text/plain")
        .body(full_body(b"500 Internal Server Error".to_vec()))
        .expect("static 500 response is always valid")
}
