//! A request body read in chunks, refused the moment it passes the cap (host-tested).

use brust_core::host::ReadErr;
use bytes::Bytes;

/// The body so far and its cap.
pub struct Capped {
    cap: usize,
    buf: Vec<u8>,
}

impl Capped {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            buf: Vec::new(),
        }
    }

    /// A declared `Content-Length` over the cap is refused before any read; an unparsable one is
    /// left to the stream.
    pub fn declared(&self, content_length: Option<&str>) -> Result<(), ReadErr> {
        match content_length.and_then(|v| v.trim().parse::<u64>().ok()) {
            Some(n) if n > self.cap as u64 => Err(ReadErr::TooLarge),
            _ => Ok(()),
        }
    }

    /// Append a chunk; `TooLarge` the moment the body passes the cap.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ReadErr> {
        if self.buf.len() + chunk.len() > self.cap {
            return Err(ReadErr::TooLarge);
        }
        self.buf.extend_from_slice(chunk);
        Ok(())
    }

    pub fn finish(self) -> Bytes {
        Bytes::from(self.buf)
    }
}

/// F475: the bytes of a streamed request body so far against `max_stream_bytes`. The body itself passes through
/// untouched; this only counts (host-tested).
pub struct StreamCount {
    max: u64,
    seen: u64,
}

impl StreamCount {
    pub fn new(max: u64) -> Self {
        Self { max, seen: 0 }
    }

    /// Count a chunk of `n` bytes; `TooLarge` the moment the total passes the ceiling.
    pub fn push(&mut self, n: u64) -> Result<(), ReadErr> {
        self.seen = self.seen.saturating_add(n);
        if self.seen > self.max {
            return Err(ReadErr::TooLarge);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_is_counted_against_the_ceiling() {
        let mut c = StreamCount::new(10);
        assert_eq!(c.push(4), Ok(()));
        assert_eq!(c.push(6), Ok(()));
        assert_eq!(c.push(1), Err(ReadErr::TooLarge));
        // once over, always over
        assert_eq!(c.push(0), Err(ReadErr::TooLarge));
        let mut c = StreamCount::new(u64::MAX);
        assert_eq!(c.push(u64::MAX), Ok(()));
        assert_eq!(c.push(1), Ok(()));
    }

    #[test]
    fn declared_length_over_the_cap_is_too_large() {
        let c = Capped::new(10);
        assert_eq!(c.declared(Some("11")), Err(ReadErr::TooLarge));
        assert_eq!(c.declared(Some("10")), Ok(()));
        assert_eq!(c.declared(Some("junk")), Ok(()));
        assert_eq!(c.declared(None), Ok(()));
    }

    #[test]
    fn push_refuses_the_chunk_that_passes_the_cap() {
        let mut c = Capped::new(10);
        assert_eq!(c.push(b"12345"), Ok(()));
        assert_eq!(c.push(b"67890"), Ok(()));
        assert_eq!(c.push(b"x"), Err(ReadErr::TooLarge));
        let mut c = Capped::new(4);
        c.push(b"ab").unwrap();
        assert_eq!(c.finish(), bytes::Bytes::from_static(b"ab"));
    }
}
