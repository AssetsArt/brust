#![cfg(target_os = "linux")]

use std::future::Future;
use std::net::SocketAddr;

pub const IO_NAME: &str = "tokio-uring";

pub fn run_io<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()>,
{
    std::thread::spawn(move || {
        tokio_uring::start(async move { f().await });
    });
}

pub fn spawn<F: Future<Output = ()> + 'static>(f: F) {
    tokio_uring::spawn(f);
}

pub struct TcpListener(tokio_uring::net::TcpListener);
pub struct TcpStream(tokio_uring::net::TcpStream);

impl TcpListener {
    pub async fn bind(addr: SocketAddr) -> std::io::Result<Self> {
        tokio_uring::net::TcpListener::bind(addr).map(Self)
    }

    pub async fn accept(&self) -> std::io::Result<(TcpStream, SocketAddr)> {
        let (s, addr) = self.0.accept().await?;
        Ok((TcpStream(s), addr))
    }
}

impl TcpStream {
    pub async fn read_request(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
        // APPEND semantics, matching other.rs (extend_from_slice). tokio-uring
        // read needs an owned buffer, so read into a fresh scratch each call and
        // append the bytes read onto `buf`. The previous mem::take+read overwrote
        // at offset 0 and never grew `buf`, so `read_full_request`'s
        // `buf.len() >= MAX_REQUEST_BYTES` 414 check never tripped (→ 400) and
        // multi-segment requests dropped earlier bytes. (brust Linux tier-1.)
        let scratch = vec![0u8; 4096];
        let (res, scratch) = self.0.read(scratch).await;
        let n = res?;
        buf.extend_from_slice(&scratch[..n]);
        Ok(n)
    }

    pub async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        let (res, _) = self.0.write_all(bytes).await;
        res
    }

    #[allow(dead_code)]
    pub async fn shutdown(&mut self) -> std::io::Result<()> {
        self.0.shutdown(std::net::Shutdown::Both)
    }

    /// Consume into a tokio `AsyncRead + AsyncWrite + Unpin` view for the WS
    /// upgrade path (mirrors `other.rs::into_inner`). The fork's `PollIo`
    /// bridges uring completion IO so `tokio-tungstenite` can drive it.
    pub fn into_inner(self) -> tokio_uring::PollIo {
        self.0.into_poll_io()
    }
}

impl crate::io::SseIo for TcpStream {
    async fn write_bytes(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        let (res, _) = self.0.write_all(bytes).await;
        res
    }

    async fn read_one_byte(&mut self) -> std::io::Result<usize> {
        let buf = vec![0u8; 1];
        let (res, _) = self.0.read(buf).await;
        res
    }

    async fn shutdown_conn(&mut self) -> std::io::Result<()> {
        self.0.shutdown(std::net::Shutdown::Both)
    }
}
