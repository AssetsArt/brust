use std::future::Future;
use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const IO_NAME: &str = "tokio";

/// Run the I/O event loop on a dedicated thread that owns a multi-thread tokio
/// runtime. The closure is `block_on`'d so the thread lives for the server's
/// lifetime.
pub fn run_io<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move { f().await });
    });
}

/// Spawn a task onto the multi-thread runtime. Futures must be `Send` because
/// the runtime may move tasks across worker threads.
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
    pub fn into_inner(self) -> tokio::net::TcpStream {
        self.0
    }
}

/// Async I/O trait used by the SSE per-connection task. Abstracts over the
/// `tokio::net::TcpStream` wrapper so `sse_conn_task` stays decoupled from the
/// concrete stream type.
pub trait SseIo: 'static {
    fn write_bytes(
        &mut self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = std::io::Result<()>>;

    fn read_one_byte(&mut self) -> impl std::future::Future<Output = std::io::Result<usize>>;

    fn shutdown_conn(&mut self) -> impl std::future::Future<Output = std::io::Result<()>>;
}

impl SseIo for TcpStream {
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
