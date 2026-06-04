//! HTTP/1.1 chunked transfer-encoding helpers + per-chunk meta parser.
//! Used by the render+action branches of handle_conn after they switch
//! to the streaming dispatch helper.

use serde::Deserialize;

/// Per-chunk meta header that prefixes the FIRST chunk's body. Worker
/// writes `[meta_len: u16 BE][meta JSON UTF-8][body bytes]` into the SAB.
/// `split_meta` separates the JSON from the body for parsing.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub(crate) struct ChunkMeta {
    pub status: u16,
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub headers: std::collections::BTreeMap<String, String>,
    /// `true` → use Transfer-Encoding: chunked. `false` → buffer into
    /// Content-Length single response.
    pub streaming: bool,
}

impl Default for ChunkMeta {
    fn default() -> Self {
        Self {
            status: 200,
            content_type: "text/html; charset=utf-8".to_string(),
            headers: Default::default(),
            streaming: false,
        }
    }
}

/// Split the first-chunk SAB layout `[meta_len: u16 BE][meta JSON][body]`
/// into (meta_slice, body_slice). Returns Err if the meta_len field is
/// missing or exceeds the buffer.
pub(crate) fn split_meta(buf: &[u8]) -> Result<(&[u8], &[u8]), &'static str> {
    if buf.len() < 2 {
        return Err("first chunk too short for meta_len header");
    }
    let meta_len = u16::from_be_bytes([buf[0], buf[1]]) as usize;
    if 2 + meta_len > buf.len() {
        return Err("meta_len exceeds chunk size");
    }
    Ok((&buf[2..2 + meta_len], &buf[2 + meta_len..]))
}

/// Build a complete single-chunk HTTP/1.1 response with Content-Length.
/// Bytes-identical to today's renderToString wire shape for no-Suspense
/// routes (spec S1 criterion #1).
///
/// Includes `Connection: keep-alive` to match `http::build_response` and
/// avoid the 47k↔109k RPS halving the team observed in A2.3: without this
/// header, oha (and any HTTP/1.1 client honoring the spec's "no header =
/// close" default) reconnects per request, doubling TCP setup overhead.
pub(crate) fn build_single_response_bytes(meta: &ChunkMeta, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n",
        meta.status,
        status_reason(meta.status),
        meta.content_type,
        body.len(),
    )
    .into_bytes();
    for (k, v) in &meta.headers {
        out.extend_from_slice(format!("{}: {}\r\n", k, v).as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

fn status_reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// Bounds check + slot lookup for napi_render_chunk. Returns the cloned
/// chunk_tx if the slot is set and `len <= buf_len`. Factored out for
/// unit testing — the NAPI fn itself wraps this in await + send.
pub fn check_chunk_dispatch(
    render_slot: &parking_lot::Mutex<Option<crate::render::pool::RenderSlot>>,
    len: u32,
    buf_len: usize,
) -> Result<tokio::sync::mpsc::Sender<crate::render::pool::RenderChunk>, String> {
    if (len as usize) > buf_len {
        return Err(format!(
            "chunk len {} exceeds SAB capacity {}",
            len, buf_len
        ));
    }
    let slot = render_slot.lock();
    slot.as_ref()
        .map(|s| s.chunk_tx.clone())
        .ok_or_else(|| "no in-flight render for this worker".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_meta_round_trip() {
        let meta_json = br#"{"status":200,"streaming":true}"#;
        let body = b"<html>";
        let mut buf = (meta_json.len() as u16).to_be_bytes().to_vec();
        buf.extend_from_slice(meta_json);
        buf.extend_from_slice(body);
        let (m, b) = split_meta(&buf).unwrap();
        assert_eq!(m, meta_json);
        assert_eq!(b, body);
    }

    #[test]
    fn split_meta_rejects_oversize_meta_len() {
        let buf = vec![0xff, 0xff, b'x'];
        assert!(split_meta(&buf).is_err());
    }

    #[test]
    fn split_meta_rejects_too_short() {
        assert!(split_meta(&[]).is_err());
        assert!(split_meta(&[0]).is_err());
    }

    #[test]
    fn meta_parse_with_streaming_true() {
        let raw = br#"{"status":200,"contentType":"text/html; charset=utf-8","headers":{},"streaming":true}"#;
        let m: ChunkMeta = serde_json::from_slice(raw).unwrap();
        assert_eq!(m.status, 200);
        assert!(m.streaming);
    }

    #[test]
    fn meta_parse_with_streaming_false() {
        let raw = br#"{"status":200,"contentType":"text/html; charset=utf-8","headers":{},"streaming":false}"#;
        let m: ChunkMeta = serde_json::from_slice(raw).unwrap();
        assert!(!m.streaming);
    }

    #[test]
    fn single_chunk_buffer_to_content_length() {
        let meta = ChunkMeta {
            status: 200,
            content_type: "text/html; charset=utf-8".to_string(),
            headers: Default::default(),
            streaming: false,
        };
        let body = b"<html>x</html>";
        let resp = build_single_response_bytes(&meta, body);
        let s = std::str::from_utf8(&resp).unwrap();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Content-Length: 14\r\n"));
        assert!(s.contains("Content-Type: text/html; charset=utf-8\r\n"));
        assert!(s.ends_with("<html>x</html>"));
    }

    #[test]
    fn len_bounds_check_rejects_oversize() {
        let slot = parking_lot::Mutex::new(None);
        let err = check_chunk_dispatch(&slot, 1_000_000, 256 * 1024).unwrap_err();
        assert!(err.contains("exceeds SAB capacity"));
    }

    #[test]
    fn slot_missing_returns_err() {
        let slot = parking_lot::Mutex::new(None);
        let err = check_chunk_dispatch(&slot, 5, 256 * 1024).unwrap_err();
        assert!(err.contains("no in-flight render"));
    }

    #[test]
    fn slot_present_returns_sender() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<crate::render::pool::RenderChunk>(1);
        let slot = parking_lot::Mutex::new(Some(crate::render::pool::RenderSlot { chunk_tx: tx }));
        assert!(check_chunk_dispatch(&slot, 5, 256 * 1024).is_ok());
    }
}
