use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::sleep;

use crate::config::socket_path;
use crate::ipc::{recv_frame, send_frame, Frame};

pub struct WorkerHandle {
    pub id: u32,
    pub socket: Mutex<UnixStream>,
    pub in_flight: AtomicU32,
    pub _child: Child, // kept alive for the process lifetime; dropped = killed
}

impl WorkerHandle {
    pub fn in_flight_guard(&self) -> InFlightGuard<'_> {
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        InFlightGuard(&self.in_flight)
    }
}

pub struct InFlightGuard<'a>(&'a AtomicU32);

impl<'a> Drop for InFlightGuard<'a> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub async fn spawn_and_handshake(
    id: u32,
    boot_timeout_ms: u64,
    routes: Arc<Vec<String>>,
) -> std::io::Result<WorkerHandle> {
    let path = socket_path(id);
    let _ = std::fs::remove_file(&path);

    let mut child = Command::new("bun")
        .args(["run", "runtime/worker.ts"])
        .env("WORKER_ID", id.to_string())
        .env("SOCKET_PATH", &path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("failed to spawn `bun`: {e}. Is bun on $PATH? Install: curl -fsSL https://bun.sh/install | bash"),
        ))?;

    // Poll-connect.
    let mut stream: Option<UnixStream> = None;
    let deadline = std::time::Instant::now() + Duration::from_millis(boot_timeout_ms);
    while std::time::Instant::now() < deadline {
        match UnixStream::connect(&path).await {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(_) => sleep(Duration::from_millis(10)).await,
        }
    }
    let mut stream = match stream {
        Some(s) => s,
        None => {
            let stderr_dump = drain_child_stderr(&mut child).await;
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!(
                    "worker {id} did not start listening within {boot_timeout_ms}ms.\nchild stderr:\n{stderr_dump}",
                ),
            ));
        }
    };

    send_frame(&mut stream, &Frame::RouteRegistry {
        routes: routes.as_ref().clone(),
    })
    .await?;
    match recv_frame(&mut stream).await? {
        Frame::Ready => {}
        other => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("worker {id} replied to RouteRegistry with {other:?}, expected Ready"),
            ));
        }
    }

    Ok(WorkerHandle {
        id,
        socket: Mutex::new(stream),
        in_flight: AtomicU32::new(0),
        _child: child,
    })
}

async fn drain_child_stderr(child: &mut Child) -> String {
    let mut buf = String::new();
    if let Some(stderr) = child.stderr.as_mut() {
        let _ = tokio::time::timeout(
            Duration::from_millis(200),
            stderr.read_to_string(&mut buf),
        )
        .await;
    }
    buf
}
