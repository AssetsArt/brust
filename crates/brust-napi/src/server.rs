//! Server bindings: `startServer`, `registerWorker`, `untilReady`, `beginDrain`,
//! `cacheInvalidate`, `cacheStats`, `localAddr` over `brust_server`.
//!
//! The CURRENT server lives in a `RwLock<Option<Arc<Server>>>` rather than a
//! `OnceCell`: `bun test` runs every file in one process and several files
//! start a server; a later `startServer` replaces the current one (the old one
//! keeps running until drained). A failed `startServer` leaves it untouched.

use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use napi::bindgen_prelude::{FnArgs, Function, Promise, Uint8Array};
use napi_derive::napi;
use parking_lot::RwLock;

use brust_server::{Config, InvalidateArgs, Server, Tuning, start};

use crate::dispatch::{BufPtr, TsfnDispatch, WorkerTsfn};

static SERVER: RwLock<Option<Arc<Server>>> = RwLock::new(None);
/// Workers the current server waits for (`StartOptions.workers`).
static EXPECTED: AtomicU32 = AtomicU32::new(0);
/// Workers registered with the current server. `brust-server` has no
/// until-ready API (its pool is `pub(crate)`), so the binding counts.
static REGISTERED: AtomicU32 = AtomicU32::new(0);

fn current() -> napi::Result<Arc<Server>> {
    SERVER
        .read()
        .clone()
        .ok_or_else(|| napi::Error::from_reason("startServer has not been called"))
}

/// Resolve `host:port`, preferring IPv4 (0.1.x `resolve_bind_addr`). Plain
/// `String` errors keep it testable without a napi host (dropping a
/// `napi::Error` needs the host's symbols).
fn resolve_bind_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve bind address {host}:{port}: {e}"))?
        .collect();
    addrs
        .iter()
        .copied()
        .find(SocketAddr::is_ipv4)
        .or_else(|| addrs.first().copied())
        .ok_or_else(|| format!("no address resolved for {host}:{port}"))
}

#[napi(object)]
pub struct StartOptions {
    pub host: String,
    pub port: u16,
    pub dist_dir: String,
    /// Workers to wait for before accepting; `0` = serve at once.
    pub workers: u32,
    pub claim_timeout_ms: Option<u32>,
    pub l1_capacity: Option<u32>,
    pub job_cache_capacity: Option<u32>,
    /// `X-Powered-By` value; absent = header not stamped.
    pub generator: Option<String>,
}

/// Boot the server (manifest, routes, templates, bind). Throws on any boot
/// error (`manifest: …`, `routes: …`, `render: …`, `bind failed on …`).
#[napi]
pub fn start_server(opts: StartOptions) -> napi::Result<()> {
    crate::init_tracing();
    let mut tuning = Tuning::default();
    if let Some(ms) = opts.claim_timeout_ms {
        tuning.claim_timeout_ms = u64::from(ms.max(1));
    }
    let cfg = Config {
        addr: resolve_bind_addr(opts.host.trim(), opts.port).map_err(napi::Error::from_reason)?,
        dist_dir: opts.dist_dir.into(),
        expected_workers: opts.workers,
        tuning,
        l1_capacity: opts.l1_capacity.map_or(1000, u64::from),
        job_cache_capacity: opts.job_cache_capacity.map_or(1000, u64::from),
        generator: opts.generator,
        ..Config::default()
    };
    let s = start(cfg).map_err(napi::Error::from_reason)?;
    let mut cur = SERVER.write();
    EXPECTED.store(opts.workers, Ordering::SeqCst);
    REGISTERED.store(0, Ordering::SeqCst);
    *cur = Some(s);
    Ok(())
}

/// Register the calling worker with the current server. `buf` is the worker's
/// SharedArrayBuffer view (kept rooted by the worker); it is split into
/// `slots` disjoint sub-regions of `floor(buf.byteLength / slots)` bytes.
/// `f(kind, requestJson, slot)` writes the response JSON at offset
/// `slot * sub` and resolves with its byte length (> 0, ≤ sub). Returns the
/// worker id.
#[napi]
pub fn register_worker(
    mut buf: Uint8Array,
    slots: u32,
    f: Function<FnArgs<(String, String, u32)>, Promise<u32>>,
) -> napi::Result<u32> {
    let s = current()?;
    // SAFETY: the SAB backing store outlives every call (the worker keeps it
    // rooted in module scope); Rust only reads it after a call's Promise resolved.
    let (buf_ptr, buf_len) = unsafe {
        let sl = buf.as_mut();
        (BufPtr(sl.as_mut_ptr()), sl.len())
    };
    let tsfn: WorkerTsfn = f.build_threadsafe_function().build()?;
    let id = s.register_worker(Box::new(TsfnDispatch {
        tsfn: Arc::new(tsfn),
        buf_ptr,
        buf_len,
        slots: slots.max(1) as usize,
    }));
    REGISTERED.fetch_add(1, Ordering::SeqCst);
    Ok(id)
}

/// Resolves once `workers` workers registered with the current server;
/// rejects after `timeout_ms` (the caller decides the exit policy).
#[napi]
pub async fn until_ready(timeout_ms: u32) -> napi::Result<()> {
    let wait = async {
        while REGISTERED.load(Ordering::SeqCst) < EXPECTED.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), wait)
        .await
        .map_err(|_| {
            napi::Error::from_reason(format!("workers failed to register within {timeout_ms} ms"))
        })
}

/// Graceful drain of the current server: stop accepting, wait for in-flight
/// connections up to `timeout_ms`.
#[napi]
pub async fn begin_drain(timeout_ms: u32) -> napi::Result<()> {
    let s = current()?;
    s.request_drain(u64::from(timeout_ms));
    s.wait_drain_done().await;
    Ok(())
}

#[napi(object)]
pub struct NapiInvalidateArgs {
    pub key: Option<String>,
    pub tags: Option<Vec<String>>,
    pub path: Option<String>,
    pub method: Option<String>,
}

#[napi(object)]
pub struct NapiInvalidateResult {
    pub l1_removed: u32,
    pub job_removed: u32,
}

/// `cache.invalidate({ key?, tags?, path?, method? })` (spec §5).
#[napi]
pub fn cache_invalidate(args: NapiInvalidateArgs) -> napi::Result<NapiInvalidateResult> {
    let r = current()?.invalidate(InvalidateArgs {
        key: args.key,
        tags: args.tags.unwrap_or_default(),
        path: args.path,
        method: args.method,
    });
    Ok(NapiInvalidateResult {
        l1_removed: u32::try_from(r.l1_removed).unwrap_or(u32::MAX),
        job_removed: u32::try_from(r.job_removed).unwrap_or(u32::MAX),
    })
}

/// `/_brust/cache/stats` JSON (snake_case keys, as the server serialises it).
#[napi]
pub fn cache_stats() -> napi::Result<String> {
    serde_json::to_string(&current()?.stats())
        .map_err(|e| napi::Error::from_reason(format!("stats: {e}")))
}

/// The bound address as `host:port` (port 0 resolves here).
#[napi]
pub fn local_addr() -> napi::Result<String> {
    Ok(current()?.local_addr().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_bind_addr_prefers_ipv4() {
        let a = resolve_bind_addr("localhost", 0).expect("localhost resolves");
        assert!(a.is_ipv4(), "{a}");
        assert_eq!(
            resolve_bind_addr("127.0.0.1", 4000).unwrap().to_string(),
            "127.0.0.1:4000"
        );
    }
}
