//! HTTP/1.1 chunked transfer-encoding helpers + per-chunk meta parser.
//! Used by the render+action branches of handle_conn after they switch
//! to the streaming dispatch helper.

use serde::Deserialize;

/// Per-chunk meta header that prefixes the FIRST chunk's body. Worker
/// writes `[meta_len: u16 BE][meta JSON UTF-8][body bytes]` into the SAB.
/// `split_meta` separates the JSON from the body for parsing.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ChunkMeta {
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
pub fn split_meta(buf: &[u8]) -> Result<(&[u8], &[u8]), &'static str> {
    if buf.len() < 2 { return Err("first chunk too short for meta_len header"); }
    let meta_len = u16::from_be_bytes([buf[0], buf[1]]) as usize;
    if 2 + meta_len > buf.len() { return Err("meta_len exceeds chunk size"); }
    Ok((&buf[2..2 + meta_len], &buf[2 + meta_len..]))
}

/// Format an HTTP/1.1 chunked-encoded chunk: `<hex_len>\r\n<bytes>\r\n`.
/// Empty `body` (len=0) returns the terminator (`0\r\n\r\n`).
///
/// Allocates one Vec per call. This matches the spec's per-chunk
/// write_all pattern (§7) — one alloc + one socket write + one drop per
/// chunk is acceptable cost given chunks are typically 4-64 KB. If
/// benchmarks ever show alloc pressure here, the signature can shift to
/// `(&[u8], &mut Vec<u8>)` without changing call sites materially.
pub fn format_chunk_framed(body: &[u8]) -> Vec<u8> {
    if body.is_empty() {
        return b"0\r\n\r\n".to_vec();
    }
    let mut out = format!("{:x}\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out.extend_from_slice(b"\r\n");
    out
}

/// Build the HTTP/1.1 response headers (no body) for a chunked stream.
/// Emits status line, fixed Transfer-Encoding: chunked, content-type,
/// then any extra headers from `meta.headers`, then the blank line.
pub fn build_chunked_response_head(meta: &ChunkMeta) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nTransfer-Encoding: chunked\r\nContent-Type: {}\r\n",
        meta.status,
        status_reason(meta.status),
        meta.content_type,
    ).into_bytes();
    for (k, v) in &meta.headers {
        out.extend_from_slice(format!("{}: {}\r\n", k, v).as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// Build a complete single-chunk HTTP/1.1 response with Content-Length.
/// Bytes-identical to today's renderToString wire shape for no-Suspense
/// routes (spec §1 criterion #1).
pub fn build_single_response_bytes(meta: &ChunkMeta, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n",
        meta.status,
        status_reason(meta.status),
        meta.content_type,
        body.len(),
    ).into_bytes();
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
    render_slot: &parking_lot::Mutex<Option<crate::pool::RenderSlot>>,
    len: u32,
    buf_len: usize,
) -> Result<tokio::sync::mpsc::Sender<crate::pool::RenderChunk>, String> {
    if (len as usize) > buf_len {
        return Err(format!("chunk len {} exceeds SAB capacity {}", len, buf_len));
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
    fn chunked_hex_prefix_format_small() {
        let out = format_chunk_framed(b"hello");
        assert_eq!(out, b"5\r\nhello\r\n");
    }

    #[test]
    fn chunked_hex_prefix_format_large() {
        let body = vec![b'a'; 0x1000];
        let out = format_chunk_framed(&body);
        assert!(out.starts_with(b"1000\r\n"));
        assert!(out.ends_with(b"\r\n"));
        assert_eq!(out.len(), 6 + 4096 + 2);
    }

    #[test]
    fn chunked_hex_prefix_format_at_sab_boundary() {
        let body = vec![b'b'; 256 * 1024];
        let out = format_chunk_framed(&body);
        assert!(out.starts_with(b"40000\r\n"));
    }

    #[test]
    fn chunked_terminator_format() {
        assert_eq!(format_chunk_framed(b""), b"0\r\n\r\n");
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
    fn chunked_response_head_format() {
        let meta = ChunkMeta {
            status: 200,
            content_type: "text/html; charset=utf-8".to_string(),
            headers: [("X-Render-Ms".to_string(), "12".to_string())].into(),
            streaming: true,
        };
        let head = build_chunked_response_head(&meta);
        let s = std::str::from_utf8(&head).unwrap();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Transfer-Encoding: chunked\r\n"));
        assert!(s.contains("X-Render-Ms: 12\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
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
        let (tx, _rx) = tokio::sync::mpsc::channel::<crate::pool::RenderChunk>(1);
        let slot = parking_lot::Mutex::new(Some(crate::pool::RenderSlot { chunk_tx: tx }));
        assert!(check_chunk_dispatch(&slot, 5, 256 * 1024).is_ok());
    }
}
