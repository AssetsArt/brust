#![deny(clippy::all)]

mod cache;
mod http;
mod io;
mod pool;
mod routes;
pub mod sse;
mod server;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::cell::Cell;
use std::time::Duration;

use napi::bindgen_prelude::{BigInt, Buffer, Function, Promise, Uint8Array};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::Result as NapiResult;
use napi_derive::napi;
use once_cell::sync::OnceCell;
use tokio::sync::Notify;
use tracing::error;
use tracing_subscriber::EnvFilter;

use crate::cache::LruCache;
use crate::pool::{BufPtr, RendererTsfn, WorkerPool};
use crate::routes::RouteTable;

thread_local! {
    static WORKER_ID: Cell<Option<u32>> = const { Cell::new(None) };
}

struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Notify>,
    routes: Arc<RouteTable>,
    cache: Arc<LruCache>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
    islands_dir: parking_lot::RwLock<Option<std::path::PathBuf>>,
    actions: parking_lot::RwLock<std::collections::HashSet<String>>,
}

static STATE: OnceCell<State> = OnceCell::new();

pub(crate) fn state() -> &'static State {
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
            routes: Arc::new(RouteTable::new()),
            cache: Arc::new(LruCache::new()),
            is_serving: AtomicBool::new(false),
            expected_workers: AtomicU32::new(0),
            islands_dir: parking_lot::RwLock::new(None),
            actions: parking_lot::RwLock::new(std::collections::HashSet::new()),
        }
    })
}

pub(crate) fn action_id_registered(id: &str) -> bool {
    state().actions.read().contains(id)
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
        Arc::clone(&s.routes),
        Arc::clone(&s.cache),
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
pub fn register_routes(configs: Vec<String>) -> NapiResult<u32> {
    let parsed: Vec<crate::routes::RouteConfig> = configs
        .iter()
        .map(|s| serde_json::from_str(s))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| napi::Error::from_reason(format!("invalid route config: {e}")))?;
    state()
        .routes
        .install_with_config(&parsed)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn configure_cache(max_entries: u32) -> NapiResult<()> {
    use std::num::NonZeroUsize;
    let n = NonZeroUsize::new(max_entries as usize)
        .ok_or_else(|| napi::Error::from_reason("cache max_entries must be > 0"))?;
    state().cache.resize(n);
    Ok(())
}

#[napi]
pub fn is_worker() -> bool {
    std::env::var("BRUST_WORKER_ID").is_ok()
}

#[napi]
pub fn worker_id() -> Option<u32> {
    WORKER_ID.with(|cell| cell.get())
}

#[napi]
pub fn configure_islands_dir(path: String) -> NapiResult<()> {
    let abs = std::path::PathBuf::from(&path);
    if !abs.is_absolute() {
        return Err(napi::Error::from_reason(format!(
            "islands_dir must be an absolute path (got {path:?})"
        )));
    }
    *state().islands_dir.write() = Some(abs);
    Ok(())
}

/// Register the set of action ids that Rust will accept on
/// /_brust/action/<id>. Called once at boot from the main thread.
/// Validates charset and rejects duplicates. Replaces any previous set
/// (no incremental registration in MVP — register once at boot).
#[napi]
pub fn register_actions(ids: Vec<String>) -> NapiResult<u32> {
    use std::collections::HashSet;
    let mut set: HashSet<String> = HashSet::with_capacity(ids.len());
    for id in &ids {
        if !is_safe_action_id(id) {
            return Err(napi::Error::from_reason(format!(
                "action id {id:?} contains invalid characters; allowed: [A-Za-z0-9_-]+"
            )));
        }
        if !set.insert(id.clone()) {
            return Err(napi::Error::from_reason(format!(
                "action id {id:?} registered more than once"
            )));
        }
    }
    let len = set.len() as u32;
    *state().actions.write() = set;
    Ok(len)
}

/// Mirrors is_safe_island_filename's spirit but with no .js suffix.
/// Allows [A-Za-z0-9_-]+ only — same charset as the TS-side island id check.
/// MUST stay in sync with src/server.rs::is_safe_action_id (covered by
/// server_action_id_matches_lib_helper test).
fn is_safe_action_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

// ----- SSE NAPI bridge -----

/// Enqueue one SSE frame for the given connection. Returns a Promise that
/// resolves when the Rust-side per-conn task has finished the TCP write —
/// cooperative backpressure for the JS reader loop.
#[napi]
pub async fn napi_sse_write(conn_id: BigInt, bytes: Buffer) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let frame_tx = {
        let reg = crate::sse::registry().lock();
        reg.get(&conn_id).map(|c| c.frame_tx.clone())
    };
    let Some(tx) = frame_tx else {
        return Err(napi::Error::from_reason(format!("conn {} not registered", conn_id)));
    };
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    let frame = crate::sse::SseFrame { bytes: bytes.to_vec(), ack: ack_tx };
    if tx.send(frame).await.is_err() {
        return Err(napi::Error::from_reason(format!("conn {} channel closed", conn_id)));
    }
    // Propagate ack errors so the JS reader loop aborts immediately instead
    // of enqueuing more frames into a torn-down conn (the next tx.send would
    // catch it eventually but several frames could be lost in the meantime).
    ack_rx.await.map_err(|_| napi::Error::from_reason(
        format!("conn {} ack dropped — TCP write failed or conn torn down", conn_id)
    ))?;
    Ok(())
}

/// Drop the connection's sender, which signals the per-conn task to exit
/// and close the TCP socket. Idempotent — a missing conn is a no-op.
#[napi]
pub fn napi_sse_close(conn_id: BigInt) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let _ = crate::sse::registry().lock().remove(&conn_id);
    Ok(())
}

/// JS provides a callback that fires once when Rust detects client disconnect.
/// Stored as a thread-safe wrapper on the SseConn.
#[napi]
pub fn napi_sse_register_abort(conn_id: BigInt, cb: Function<(), ()>) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let tsfn = cb.build_threadsafe_function().build()?;
    let mut reg = crate::sse::registry().lock();
    if let Some(conn) = reg.get_mut(&conn_id) {
        conn.abort_cb = Some(Box::new(move || {
            // Fire-and-forget — non-blocking call into JS.
            let _ = tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
        }));
    }
    Ok(())
}

/// JS reports the middleware open verdict. Single-shot — a second call is
/// dropped (open_tx is taken on first use).
#[napi]
pub fn napi_sse_signal_open(
    conn_id: BigInt,
    status: u32,
    body: Buffer,
    content_type: String,
) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let open_tx = {
        let mut reg = crate::sse::registry().lock();
        reg.get_mut(&conn_id).and_then(|c| c.open_tx.take())
    };
    if let Some(tx) = open_tx {
        let _ = tx.send(crate::sse::SseOpenSignal {
            status: status as u16,
            body: body.to_vec(),
            content_type,
        });
    }
    Ok(())
}

/// Convert a NAPI BigInt to u64, rejecting negative values.
/// conn_ids cross the JS/Rust boundary as BigInt because JS Number tops out
/// at 2^53 while conn_ids are monotonic u64 from an AtomicU64.
fn bigint_to_u64(b: &BigInt) -> NapiResult<u64> {
    let (signed, value, lossless) = b.get_u64();
    if signed {
        return Err(napi::Error::from_reason("conn_id must be non-negative"));
    }
    if !lossless {
        return Err(napi::Error::from_reason("conn_id overflows u64"));
    }
    Ok(value)
}

#[cfg(test)]
mod action_id_tests {
    use super::is_safe_action_id;

    #[test] fn ascii_alphanumeric_passes() {
        assert!(is_safe_action_id("createNote"));
        assert!(is_safe_action_id("whoAmI"));
        assert!(is_safe_action_id("a_b-c"));
        assert!(is_safe_action_id("X"));
        assert!(is_safe_action_id("123abc"));
    }
    #[test] fn empty_rejected() { assert!(!is_safe_action_id("")); }
    #[test] fn too_long_rejected() {
        let s: String = "a".repeat(129);
        assert!(!is_safe_action_id(&s));
    }
    #[test] fn dot_rejected() { assert!(!is_safe_action_id("a.b")); }
    #[test] fn slash_rejected() { assert!(!is_safe_action_id("a/b")); }
    #[test] fn double_dot_rejected() { assert!(!is_safe_action_id("..")); }
    #[test] fn non_ascii_rejected() { assert!(!is_safe_action_id("évil")); }
    #[test] fn space_rejected() { assert!(!is_safe_action_id("a b")); }
}

