#[cfg(target_os = "linux")]
pub use self::linux::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(not(target_os = "linux"))]
pub use self::other::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(target_os = "linux")]
mod linux;

#[cfg(not(target_os = "linux"))]
mod other;

/// Platform-generic async I/O trait used by the SSE per-connection task.
/// Abstracts over `tokio::net::TcpStream` (non-Linux) and
/// `tokio_uring::net::TcpStream` (Linux) so `sse_conn_task` compiles on
/// both targets without pulling in the `AsyncRead`/`AsyncWrite` traits that
/// tokio-uring does not implement.
pub trait SseIo: Send + 'static {
    fn write_bytes(
        &mut self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = std::io::Result<()>> + Send;

    fn read_one_byte(
        &mut self,
    ) -> impl std::future::Future<Output = std::io::Result<usize>> + Send;

    fn shutdown_conn(
        &mut self,
    ) -> impl std::future::Future<Output = std::io::Result<()>> + Send;
}
