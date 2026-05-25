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

    pub async fn shutdown(&mut self) -> std::io::Result<()> {
        self.0.shutdown().await
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
