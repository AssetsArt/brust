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

#[cfg(test)]
mod tests {
    use super::*;

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
