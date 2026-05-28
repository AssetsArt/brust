#![cfg(not(target_os = "linux"))]

use std::future::Future;
use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const IO_NAME: &str = "tokio";

pub fn run_io<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move { f().await });
    });
}

pub fn spawn<F: Future<Output = ()> + Send + 'static>(f: F) {
    tokio::spawn(f);
}

pub struct TcpListener(tokio::net::TcpListener);
pub struct TcpStream(tokio::net::TcpStream);

impl TcpListener {
    pub async fn bind(addr: SocketAddr) -> std::io::Result<Self> {
        tokio::net::TcpListener::bind(addr).await.map(Self)
    }

    pub async fn accept(&self) -> std::io::Result<(TcpStream, SocketAddr)> {
        let (s, addr) = self.0.accept().await?;
        Ok((TcpStream(s), addr))
    }
}

impl TcpStream {
    pub async fn read_request(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
        let mut tmp = [0u8; 4096];
        let n = self.0.read(&mut tmp).await?;
        buf.extend_from_slice(&tmp[..n]);
        Ok(n)
    }

    pub async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        self.0.write_all(&bytes).await
    }

    #[allow(dead_code)]
    pub async fn shutdown(&mut self) -> std::io::Result<()> {
        self.0.shutdown().await
    }

    /// Unwrap the inner tokio stream. Used by the WS branch in server.rs to
    /// hand off to `tokio_tungstenite::WebSocketStream::from_raw_socket`,
    /// which requires `AsyncRead + AsyncWrite + Unpin` (satisfied by
    /// `tokio::net::TcpStream` but not by this newtype wrapper).
    /// Only available on non-Linux targets; on Linux the uring stream does
    /// not impl AsyncRead/AsyncWrite — that path needs a WsIo abstraction.
    pub fn into_inner(self) -> tokio::net::TcpStream {
        self.0
    }
}

impl crate::io::SseIo for TcpStream {
    async fn write_bytes(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        self.0.write_all(&bytes).await
    }

    async fn read_one_byte(&mut self) -> std::io::Result<usize> {
        let mut b = [0u8; 1];
        self.0.read(&mut b).await
    }

    async fn shutdown_conn(&mut self) -> std::io::Result<()> {
        self.0.shutdown().await
    }
}

/// Vectored-write loop generic over `AsyncWrite + Unpin`. Factored out
/// so unit tests can drive it with `tokio::io::duplex` without needing
/// a real TCP socket. Production callers go through
/// `TcpStream::write_all_vectored`.
///
/// `tokio::io::AsyncWriteExt::write_vectored` lives behind the `io-util`
/// feature, which `Cargo.toml` enables on `cfg(not(linux))`. Verified
/// via tokio src that `TcpStream` reports `is_write_vectored = true`
/// and delegates to `writev(2)` via mio.
async fn write_all_vectored_impl<W: tokio::io::AsyncWrite + Unpin>(
    w: &mut W,
    bufs: &mut [std::io::IoSlice<'_>],
) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    // `IoSlice::advance_slices` takes `&mut &mut [IoSlice]` — rebind
    // through a mutable local so we can pass `&mut bufs`.
    let mut bufs: &mut [std::io::IoSlice<'_>] = bufs;
    while !bufs.is_empty() {
        let n = w.write_vectored(bufs).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        std::io::IoSlice::advance_slices(&mut bufs, n);
    }
    Ok(())
}

impl TcpStream {
    /// Vectored write that drains all slices. Used by the buffering hot
    /// path in `dispatch_to_worker_and_stream_chunks` to emit
    /// `[response_head, body]` in one syscall without a userspace body
    /// memcpy. Nylon-ring zero-copy NrVec<u8> in spirit.
    pub async fn write_all_vectored(
        &mut self,
        bufs: &mut [std::io::IoSlice<'_>],
    ) -> std::io::Result<()> {
        write_all_vectored_impl(&mut self.0, bufs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::IoSlice;

    #[tokio::test]
    async fn write_all_vectored_drains_all_slices() {
        // tokio::io::duplex doesn't override poll_write_vectored, so the
        // default impl writes only the FIRST slice through poll_write.
        // That's exactly what we want to test — the loop's ability to
        // advance through multiple slices.
        let (mut a, mut b) = tokio::io::duplex(1024);
        let s1 = b"hello ".as_slice();
        let s2 = b"world".as_slice();
        let mut bufs = [IoSlice::new(s1), IoSlice::new(s2)];
        write_all_vectored_impl(&mut a, &mut bufs).await.unwrap();
        drop(a);
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        b.read_to_end(&mut out).await.unwrap();
        assert_eq!(&out, b"hello world");
    }

    #[tokio::test]
    async fn write_all_vectored_empty_input_returns_ok() {
        let (mut a, _b) = tokio::io::duplex(1024);
        let mut bufs: [IoSlice<'_>; 0] = [];
        write_all_vectored_impl(&mut a, &mut bufs).await.unwrap();
    }

    #[tokio::test]
    async fn write_all_vectored_single_slice_drains() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let payload = b"the quick brown fox".as_slice();
        let mut bufs = [IoSlice::new(payload)];
        write_all_vectored_impl(&mut a, &mut bufs).await.unwrap();
        drop(a);
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        b.read_to_end(&mut out).await.unwrap();
        assert_eq!(&out, payload);
    }
}
