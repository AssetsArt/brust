#![deny(clippy::all)]

mod http;
mod io;
mod pool;
mod server;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::cell::Cell;
use std::time::Duration;

use napi::bindgen_prelude::{Function, Promise, Uint8Array};
use napi::Result as NapiResult;
use napi_derive::napi;
use once_cell::sync::OnceCell;
use tokio::sync::Notify;
use tracing::error;
use tracing_subscriber::EnvFilter;

use crate::pool::{BufPtr, RendererTsfn, WorkerPool};

thread_local! {
    static WORKER_ID: Cell<Option<u32>> = const { Cell::new(None) };
}

struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Notify>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
}

static STATE: OnceCell<State> = OnceCell::new();

fn state() -> &'static State {
    STATE.get_or_init(|| {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| EnvFilter::new("brust=info")),
            )
            .with_target(false)
            .with_writer(std::io::stderr)
            .try_init();
        State {
            pool: Arc::new(WorkerPool::new()),
            ready: Arc::new(Notify::new()),
            shutdown: Arc::new(Notify::new()),
            is_serving: AtomicBool::new(false),
            expected_workers: AtomicU32::new(0),
        }
    })
}

#[napi(object)]
pub struct ServeOptions {
    pub port: u16,
    pub workers: u32,
    pub entry: String,
}

#[napi]
pub fn begin_serve(opts: ServeOptions) -> NapiResult<()> {
    let s = state();
    if s.is_serving.swap(true, Ordering::SeqCst) {
        return Err(napi::Error::from_reason("serve already running"));
    }
    s.expected_workers.store(opts.workers, Ordering::SeqCst);

    let addr: SocketAddr = format!("127.0.0.1:{}", opts.port)
        .parse()
        .map_err(|e: std::net::AddrParseError| napi::Error::from_reason(e.to_string()))?;

    // Process shutdown is owned by the TS layer: runtime/index.ts installs
    // process.on('SIGINT', () => process.exit(0)). Bun intercepts SIGINT before
    // tokio::signal::ctrl_c() can fire in this process, so a Rust-side handler
    // is a no-op under Bun. until_shutdown() below parks the calling Promise
    // on s.shutdown forever; the parking ends when JS exits the process.
    server::start(
        addr,
        Arc::clone(&s.ready),
        Arc::clone(&s.pool),
        opts.workers as usize,
    );
    Ok(())
}

#[napi]
pub async fn until_ready(timeout_ms: u32) -> NapiResult<()> {
    let s = state();
    let expected = s.expected_workers.load(Ordering::SeqCst) as usize;
    let pool = Arc::clone(&s.pool);
    let ready = Arc::clone(&s.ready);
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms as u64), async {
        while pool.registered_count() < expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ready.notify_one();
    })
    .await;
    if result.is_err() {
        error!(timeout_ms, "workers failed to register");
        std::process::exit(1);
    }
    Ok(())
}

#[napi]
pub async fn until_shutdown() -> NapiResult<()> {
    state().shutdown.notified().await;
    Ok(())
}

#[napi]
pub fn register_renderer(
    mut buf: Uint8Array,
    f: Function<String, Promise<u32>>,
) -> NapiResult<u32> {
    // NOTE: is_worker() reads std::env::var which is not patched by Bun's Worker
    // env option (Bun Workers share the OS process).  The TS layer is responsible
    // for only calling registerRenderer from a worker context; we skip the guard.
    //
    // Capture the SAB backing-store pointer + length here. The Bun Worker keeps the
    // SAB rooted in its module scope, so the backing store outlives every render call.
    let (buf_ptr, buf_len) = unsafe {
        let slice = buf.as_mut();
        (BufPtr(slice.as_mut_ptr()), slice.len())
    };
    let tsfn: RendererTsfn = f.build_threadsafe_function().build()?;
    let id = state().pool.register(tsfn, buf_ptr, buf_len);
    WORKER_ID.with(|cell| cell.set(Some(id)));
    Ok(id)
}

#[napi]
pub fn is_worker() -> bool {
    std::env::var("BRUST_WORKER_ID").is_ok()
}

#[napi]
pub fn worker_id() -> Option<u32> {
    WORKER_ID.with(|cell| cell.get())
}

