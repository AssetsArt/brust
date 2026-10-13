//! Server bindings: `startServer`, `registerWorker`, `untilReady`, `beginDrain`,
//! `cacheInvalidate`, `cacheStats`, `localAddr`, `planJobs`, `planJobsBuf`, `takeFetchBody`, `putFetchReply`
//! over `brust_server`.
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

use brust_server::{
    ActionsConfig, Config, CorsConfig, CrossSite, DEFAULT_ACTION_PREFIX,
    DEFAULT_MAX_ACTION_BODY_BYTES, DEFAULT_MAX_ACTION_RESPONSE_BYTES, InvalidateArgs, Server,
    Tuning, start,
};

use crate::dispatch::{BufPtr, KindArg, TsfnDispatch, WorkerTsfn};

static SERVER: RwLock<Option<Arc<Server>>> = RwLock::new(None);
/// Workers the current server waits for (`StartOptions.workers`).
static EXPECTED: AtomicU32 = AtomicU32::new(0);
/// Workers registered with the current server. `brust-server` has no
/// until-ready API (its pool is `pub(crate)`), so the binding counts.
static REGISTERED: AtomicU32 = AtomicU32::new(0);

thread_local! {
    /// The server and worker id registered from THIS thread (`register_worker`): a worker's
    /// `planJobs` runs on its own JS thread, so this is that worker's binding. A stale or absent
    /// binding makes `plan_jobs` decline, which degrades to the two-call path.
    static BOUND: std::cell::RefCell<Option<Binding<Server>>> = const { std::cell::RefCell::new(None) };
}

/// One thread's registration: the server, the worker id, and whether a SECOND worker of the
/// same live server registered on this thread too (tests can; `run.ts` never does — one Bun
/// Worker thread per worker). `planJobs` carries no worker id, so with two live workers on one
/// thread it could plan against the wrong one's slot: it declines instead.
struct Binding<T> {
    server: std::sync::Weak<T>,
    id: u32,
    ambiguous: bool,
}

/// Record `s`/`id` as this thread's registration (see [`Binding`]).
fn bind<T>(cur: &mut Option<Binding<T>>, s: &Arc<T>, id: u32) {
    let same_live = cur
        .as_ref()
        .and_then(|b| b.server.upgrade())
        .is_some_and(|prev| Arc::ptr_eq(&prev, s));
    *cur = Some(Binding {
        server: Arc::downgrade(s),
        id,
        ambiguous: same_live,
    });
}

/// The server and worker id `planJobs` may plan for, or `None` (decline): no registration on
/// this thread, the server is gone, or the binding is ambiguous.
fn bound<T>(cur: &Option<Binding<T>>) -> Option<(Arc<T>, u32)> {
    let b = cur.as_ref().filter(|b| !b.ambiguous)?;
    Some((b.server.upgrade()?, b.id))
}

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

/// Global CORS (0.1.x `NapiCorsOptions`, brust/src/lib.rs:79-98); napi camelCases the keys:
/// `origins, methods, headers, exposeHeaders, credentials, maxAgeSeconds`. Validated by `start` (`cors: …`).
#[napi(object)]
pub struct NapiCorsOptions {
    pub origins: Vec<String>,
    pub methods: Option<Vec<String>>,
    pub headers: Option<Vec<String>>,
    pub expose_headers: Option<Vec<String>>,
    pub credentials: Option<bool>,
    pub max_age_seconds: Option<u32>,
}

/// M3-F A3 consumer `{ prefix?, maxBodyBytes?, maxResponseBytes? }` (defaults `/_brust/action`, 1 MiB, 8 MiB). Present = actions on.
#[napi(object)]
pub struct NapiActionsOptions {
    pub prefix: Option<String>,
    pub max_body_bytes: Option<u32>,
    /// F82: cap on an action response body (default 8388608).
    pub max_response_bytes: Option<u32>,
    /// `"reject"` (default) or `"allow"` (F87): cross-site mutating action requests.
    pub cross_site: Option<String>,
}

/// Field for field; an absent `credentials` is `false`.
fn cors_config(c: NapiCorsOptions) -> CorsConfig {
    CorsConfig {
        origins: c.origins,
        methods: c.methods,
        headers: c.headers,
        expose_headers: c.expose_headers,
        credentials: c.credentials.unwrap_or(false),
        max_age_seconds: c.max_age_seconds,
    }
}

/// Absent keys take the `brust-server` defaults.
fn actions_config(a: NapiActionsOptions) -> ActionsConfig {
    ActionsConfig {
        prefix: a.prefix.unwrap_or_else(|| DEFAULT_ACTION_PREFIX.into()),
        max_body_bytes: a
            .max_body_bytes
            .map_or(DEFAULT_MAX_ACTION_BODY_BYTES, |n| n as usize),
        max_response_bytes: a
            .max_response_bytes
            .map_or(DEFAULT_MAX_ACTION_RESPONSE_BYTES, |n| n as usize),
        cross_site: match a.cross_site.as_deref() {
            Some("allow") => CrossSite::Allow,
            _ => CrossSite::Reject,
        },
    }
}

/// The cache adapter (`[cache]`, cache-adapter lane A); built by `brust start` from `manifest.cache`.
#[napi(object)]
pub struct NapiL2Options {
    pub adapter: String,
    /// The `store.get` budget; absent = 50.
    pub get_timeout_ms: Option<u32>,
    /// A bigger rendered body is not written; absent = 1 048 576.
    pub max_body_bytes: Option<u32>,
    pub namespace: String,
    pub build_id: String,
}

/// Absent keys take the native defaults (R4, spec §6).
fn l2_config(o: NapiL2Options) -> brust_server::l2::L2Config {
    brust_server::l2::L2Config {
        adapter: o.adapter,
        get_timeout: Duration::from_millis(u64::from(o.get_timeout_ms.unwrap_or(50).max(1))),
        max_body_bytes: o.max_body_bytes.map_or(1_048_576, |n| n as usize),
        namespace: o.namespace,
        build_id: o.build_id,
    }
}

#[napi(object)]
pub struct StartOptions {
    pub host: String,
    pub port: u16,
    pub dist_dir: String,
    /// Workers to wait for before accepting; `0` = serve at once.
    pub workers: u32,
    pub claim_timeout_ms: Option<u32>,
    /// A claimed worker call that has not settled after this long answers
    /// 504 (the slot stays claimed until JS settles). Absent = 30 000.
    pub call_timeout_ms: Option<u32>,
    /// L10: the biggest loader/jobs reply that may cross the heap when it does not fit the slot
    /// (256 KiB..=64 MiB; boot error otherwise). Absent = 8 MiB.
    pub max_loader_response_bytes: Option<u32>,
    /// tokio threads of the HTTP runtime (every page renders there); absent =
    /// one per core (`Tuning::default`).
    pub worker_threads: Option<u32>,
    pub l1_capacity: Option<u32>,
    pub job_cache_capacity: Option<u32>,
    /// `X-Powered-By` value; absent = header not stamped.
    pub generator: Option<String>,
    /// Global CORS policy; absent = CORS off.
    pub cors: Option<NapiCorsOptions>,
    /// The actions subtree (M3-F); absent = no actions (byte-identical server).
    pub actions: Option<NapiActionsOptions>,
    /// The cache adapter; absent = none (byte-identical server).
    pub l2: Option<NapiL2Options>,
    /// `brust dev` only (L14): a request carrying this token in `x-brust-dev-token` is traced. Absent in production.
    pub dev_token: Option<String>,
}

/// Boot the server (manifest, routes, templates, bind). Throws on any boot
/// error (`manifest: …`, `routes: …`, `render: …`, `cors: …`, `actions: …`,
/// `bind failed on …`).
#[napi]
pub fn start_server(opts: StartOptions) -> napi::Result<()> {
    crate::init_tracing();
    let mut tuning = Tuning::default();
    if let Some(ms) = opts.claim_timeout_ms {
        tuning.claim_timeout_ms = u64::from(ms.max(1));
    }
    if let Some(ms) = opts.call_timeout_ms {
        tuning.call_timeout_ms = u64::from(ms.max(1));
    }
    if let Some(n) = opts.max_loader_response_bytes {
        tuning.max_loader_response_bytes = n as usize;
    }
    if let Some(n) = opts.worker_threads {
        tuning.worker_threads = n.max(1) as usize;
    }
    let cfg = Config {
        addr: resolve_bind_addr(opts.host.trim(), opts.port).map_err(napi::Error::from_reason)?,
        dist_dir: opts.dist_dir.into(),
        expected_workers: opts.workers,
        tuning,
        l1_capacity: opts.l1_capacity.map_or(1000, u64::from),
        job_cache_capacity: opts.job_cache_capacity.map_or(1000, u64::from),
        generator: opts.generator,
        cors: opts.cors.map(cors_config),
        actions: opts.actions.map(actions_config),
        l2: opts.l2.map(l2_config),
        dev_token: opts.dev_token,
        ..Config::default()
    };
    let s = start(cfg).map_err(napi::Error::from_reason)?;
    let mut cur = SERVER.write();
    EXPECTED.store(opts.workers, Ordering::SeqCst);
    REGISTERED.store(0, Ordering::SeqCst);
    *cur = Some(s);
    Ok(())
}

/// Register the calling worker with the current server. `buf` is a view of
/// the worker's SharedArrayBuffer, which must outlive the process's use of
/// this worker (`brust start` allocates it on the main thread and keeps it for
/// the process lifetime: `dispatch.rs` BufPtr); it is split into
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
    // SAFETY: the SAB backing store outlives every call (owned by the main
    // thread for the process lifetime — see `BufPtr`); Rust only reads it after
    // a call's Promise resolved.
    let (buf_ptr, buf_len) = unsafe {
        let sl = buf.as_mut();
        (BufPtr(sl.as_mut_ptr()), sl.len())
    };
    // The JS-facing declaration keeps `kind: string`; the tsfn's data type is
    // the allocation-free `KindArg` (see `dispatch::KindArg`).
    let tsfn: WorkerTsfn = f
        .build_threadsafe_function::<FnArgs<(KindArg, String, u32)>>()
        .build_callback(|ctx| Ok(ctx.value))?;
    let id = s.register_worker(Box::new(TsfnDispatch {
        tsfn: Arc::new(tsfn),
        buf_ptr,
        buf_len,
        slots: slots.max(1) as usize,
    }));
    BOUND.with_borrow_mut(|b| bind(b, &s, id));
    REGISTERED.fetch_add(1, Ordering::SeqCst);
    Ok(id)
}

/// M3-P P6: plan the calling worker's in-flight loader call for `slot` from the `len` bytes it
/// just wrote there. Returns the misses' `JobsRequest` JSON, `""` when every job hit, or `"!"`
/// (declined: answer with the loader response already in the slot). Sync, on the worker's JS
/// thread; never throws (a napi Error return is unreliable under Bun).
#[napi]
pub fn plan_jobs(slot: u32, len: u32) -> String {
    match BOUND.with_borrow(bound) {
        Some((s, id)) => brust_server::plan_in_call(&s, id, slot, len),
        None => brust_server::PLAN_DECLINED.to_string(),
    }
}

/// L10: [`plan_jobs`] for a loader response too large for the slot: the worker hands the bytes
/// over in `buf` instead of writing them to the slot. Same answers (`""`, the misses' JSON, or
/// `"!"`); a declined plan leaves the response for the worker to hand over with `putFetchReply`.
#[napi]
pub fn plan_jobs_buf(slot: u32, buf: Uint8Array) -> String {
    match BOUND.with_borrow(bound) {
        Some((s, id)) => brust_server::plan_in_call_buf(&s, id, slot, &buf),
        None => brust_server::PLAN_DECLINED.to_string(),
    }
}

/// F82: the heap request body of the calling worker's in-flight `fetch` call for `slot`, once.
/// `None` when there is none, nothing is bound, or the binding is ambiguous. Sync, on the
/// worker's JS thread; never throws.
#[napi]
pub fn take_fetch_body(slot: u32) -> Option<Uint8Array> {
    let (s, id) = BOUND.with_borrow(bound)?;
    brust_server::take_fetch_body(&s, id, slot).map(Uint8Array::new)
}

/// F82: hand Rust the response body of the calling worker's in-flight `fetch` call for `slot`
/// (too large for the SAB slot). `false` = declined (over `max_response_bytes`, not in a `fetch`
/// call, already put, nothing bound). Sync, on the worker's JS thread; never throws.
#[napi]
pub fn put_fetch_reply(slot: u32, body: Uint8Array) -> bool {
    match BOUND.with_borrow(bound) {
        Some((s, id)) => brust_server::put_fetch_reply(&s, id, slot, &body),
        None => false,
    }
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

/// A broadcast invalidation another process published (worker 0's subscriber, cache-adapter R10):
/// tier 1 + the floor at `seq`. Never re-published (L3). Same args/result as `cache_invalidate`.
#[napi]
pub fn cache_replay(
    args: NapiInvalidateArgs,
    seq: Option<i64>,
) -> napi::Result<NapiInvalidateResult> {
    let r = current()?.l2_replay(
        InvalidateArgs {
            key: args.key,
            tags: args.tags.unwrap_or_default(),
            path: args.path,
            method: args.method,
        },
        seq.and_then(|n| u64::try_from(n).ok()),
    );
    Ok(NapiInvalidateResult {
        l1_removed: u32::try_from(r.l1_removed).unwrap_or(u32::MAX),
        job_removed: u32::try_from(r.job_removed).unwrap_or(u32::MAX),
    })
}

/// Bump the `stats.l2` counter `name` (the JS side's counts, R9). `false` = unknown name, no
/// adapter, or no server. Never throws.
#[napi]
pub fn cache_l2_count(name: String) -> bool {
    current().is_ok_and(|s| s.l2_count(&name))
}

/// Drop both tier-1 caches (a broadcast gap, R10); `stats.l2.resets`++. The L1 entries removed.
#[napi]
pub fn cache_clear() -> napi::Result<u32> {
    Ok(u32::try_from(current()?.cache_clear()).unwrap_or(u32::MAX))
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

/// Static output (gaps round R9.4): the request reads of one `cache.prefix` / `cache.bypass`
/// expression (`header(x)`, `cookie(x)`, `query(x)`, `request(host)`), parsed by the server's own
/// grammar. Errors when the expression does not parse. Needs no running server.
#[napi]
pub fn cache_expr_reads(src: String) -> napi::Result<Vec<String>> {
    brust_core::cache::key_expr::Expr::parse(&src)
        .map(|e| e.request_reads())
        .map_err(napi::Error::from_reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_live_registration_on_one_thread_for_the_same_server_makes_the_binding_ambiguous() {
        let a = Arc::new(1u8);
        let mut b: Option<Binding<u8>> = None;
        bind(&mut b, &a, 0);
        assert_eq!(bound(&b).map(|(_, id)| id), Some(0));
        // Two live workers of one server on one thread: planJobs cannot tell which call it is in.
        bind(&mut b, &a, 1);
        assert!(bound(&b).is_none(), "ambiguous binding must decline");
        bind(&mut b, &a, 2);
        assert!(bound(&b).is_none(), "stays ambiguous for that server");
        // A new server (the old one replaced) rebinds cleanly.
        let c = Arc::new(2u8);
        bind(&mut b, &c, 0);
        assert_eq!(bound(&b).map(|(_, id)| id), Some(0));
        // A dropped server is stale: the next registration rebinds, the stale one declines.
        drop(c);
        assert!(bound(&b).is_none());
        let d = Arc::new(3u8);
        bind(&mut b, &d, 5);
        assert_eq!(bound(&b).map(|(_, id)| id), Some(5));
    }

    #[test]
    fn cors_options_map_onto_cors_config() {
        let c = cors_config(NapiCorsOptions {
            origins: vec!["https://a.example".into()],
            methods: None,
            headers: Some(vec!["x-token".into()]),
            expose_headers: Some(vec!["x-id".into()]),
            credentials: None,
            max_age_seconds: Some(60),
        });
        assert_eq!(
            c,
            CorsConfig {
                origins: vec!["https://a.example".into()],
                methods: None,
                headers: Some(vec!["x-token".into()]),
                expose_headers: Some(vec!["x-id".into()]),
                credentials: false,
                max_age_seconds: Some(60),
            }
        );
        let creds = NapiCorsOptions {
            origins: vec!["https://a.example".into()],
            methods: Some(vec!["GET".into()]),
            headers: None,
            expose_headers: None,
            credentials: Some(true),
            max_age_seconds: None,
        };
        let c = cors_config(creds);
        assert!(c.credentials);
        assert_eq!(c.methods, Some(vec!["GET".to_string()]));
    }

    #[test]
    fn actions_options_default() {
        let none = NapiActionsOptions {
            prefix: None,
            max_body_bytes: None,
            max_response_bytes: None,
            cross_site: None,
        };
        assert_eq!(actions_config(none), ActionsConfig::default());
        assert_eq!(ActionsConfig::default().max_response_bytes, 8_388_608);
        let set = NapiActionsOptions {
            prefix: Some("/api".into()),
            max_body_bytes: Some(1024),
            max_response_bytes: Some(1 << 20),
            cross_site: Some("allow".into()),
        };
        assert_eq!(
            actions_config(set),
            ActionsConfig {
                prefix: "/api".into(),
                max_body_bytes: 1024,
                max_response_bytes: 1 << 20,
                cross_site: CrossSite::Allow,
            }
        );
    }

    #[test]
    fn l2_options_default() {
        let c = l2_config(NapiL2Options {
            adapter: "custom".into(),
            get_timeout_ms: None,
            max_body_bytes: None,
            namespace: "ns".into(),
            build_id: "b".into(),
        });
        assert_eq!(c.get_timeout, Duration::from_millis(50));
        assert_eq!(c.max_body_bytes, 1_048_576);
        assert_eq!(
            (
                c.adapter.as_str(),
                c.namespace.as_str(),
                c.build_id.as_str()
            ),
            ("custom", "ns", "b")
        );
        let c = l2_config(NapiL2Options {
            adapter: "redis".into(),
            get_timeout_ms: Some(200),
            max_body_bytes: Some(1024),
            namespace: "ns".into(),
            build_id: "b".into(),
        });
        assert_eq!(
            (c.get_timeout, c.max_body_bytes),
            (Duration::from_millis(200), 1024)
        );
    }

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
