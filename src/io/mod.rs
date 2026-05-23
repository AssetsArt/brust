#[cfg(target_os = "linux")]
pub use self::linux::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(not(target_os = "linux"))]
pub use self::other::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(target_os = "linux")]
mod linux;

#[cfg(not(target_os = "linux"))]
mod other;
