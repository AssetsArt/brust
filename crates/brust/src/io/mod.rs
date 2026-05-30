#[cfg(target_os = "linux")]
pub use self::linux::{IO_NAME, TcpListener, TcpStream, run_io, spawn};

#[cfg(not(target_os = "linux"))]
pub use self::other::{IO_NAME, TcpListener, TcpStream, run_io, spawn};

#[cfg(target_os = "linux")]
mod linux;

#[cfg(not(target_os = "linux"))]
mod other;

/// Platform-generic async I/O trait used by the SSE per-connection task.
/// Abstracts over `tokio::net::TcpStream` (non-Linux) and
/// `tokio_uring::net::TcpStream` (Linux) so `sse_conn_task` compiles on
/// both targets without pulling in the `AsyncRead`/`AsyncWrite` traits that
/// tokio-uring does not implement.
// NOTE: deliberately NOT `Send`-bound. The per-platform `spawn` (this module)
// already encodes the Send requirement where it's real: `other.rs` (tokio,
// non-Linux) bounds `F: Send`; `linux.rs` (tokio-uring, single-thread) does
// not. tokio-uring's stream futures hold `Rc` and are never `Send`, so a `Send`
// bound here makes the Linux impl uncompilable for zero benefit (the uring
// runtime never moves the task across threads). `tokio::spawn` on non-Linux
// still checks the *concrete* future's auto-traits, so the Send guarantee the
// non-Linux path needs is preserved without the bound. (Earlier this trait was
// `Send`-bound, which silently broke the Linux build — there was no Linux CI.)
pub trait SseIo: 'static {
    fn write_bytes(
        &mut self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = std::io::Result<()>>;

    fn read_one_byte(&mut self) -> impl std::future::Future<Output = std::io::Result<usize>>;

    fn shutdown_conn(&mut self) -> impl std::future::Future<Output = std::io::Result<()>>;
}
