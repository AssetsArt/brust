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
        // tokio-uring read takes ownership; we swap the buffer
        let owned = std::mem::take(buf);
        let (res, returned) = self.0.read(owned).await;
        *buf = returned;
        res
    }

    pub async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        let (res, _) = self.0.write_all(bytes).await;
        res
    }

    /// Compatibility stub on Linux. tokio-uring's `writev` expects owned
    /// `BoundedBuf`-conforming buffers; our buffering hot path holds a
    /// borrowed body slice into channel-delivered `data: Vec<u8>`. For
    /// now, concat into a single Vec and write in one call — preserving
    /// current Linux behavior. Real io_uring writev support is deferred
    /// to a future sub-project once a Linux bench baseline exists (spec
    /// "Known limitations §1").
    #[allow(dead_code)]
    pub async fn write_all_vectored(
        &mut self,
        bufs: &mut [std::io::IoSlice<'_>],
    ) -> std::io::Result<()> {
        let total: usize = bufs.iter().map(|s| s.len()).sum();
        let mut merged: Vec<u8> = Vec::with_capacity(total);
        for s in bufs.iter() {
            merged.extend_from_slice(s);
        }
        let (res, _) = self.0.write_all(merged).await;
        res
    }

    #[allow(dead_code)]
    pub async fn shutdown(&mut self) -> std::io::Result<()> {
        self.0.shutdown(std::net::Shutdown::Both)
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
