//! `FakeBun`: an in-process [`RenderDispatch`] standing in for the Bun worker.
//! It parses the inline request JSON, counts calls per [`CallKind`], records the
//! last request of each kind, and writes the canned JSON response into its SAB
//! slot exactly as the real worker does (a `fetch` responder returns the A2
//! frame bytes itself, [`super::frame`]). Bound to its server ([`FakeBun::bind`],
//! done by `boot*`), it takes the plan offer of `loader` requests like the real
//! worker (M3-P P6). Counts are (loader runs, job batches) — a planned call
//! counts one of each, as the two-call path did.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use brust_server::Server;
use brust_server::dispatch::{CallKind, DispatchError, RenderDispatch};
use serde_json::{Value, json};

type Responder = Box<dyn Fn(Value) -> Value + Send + Sync>;
type FetchResponder = Box<dyn Fn(Value) -> Vec<u8> + Send + Sync>;

pub struct FakeBun {
    /// `loader` request JSON → response JSON.
    pub loader: Responder,
    /// `jobs` request JSON → response JSON.
    pub jobs: Responder,
    pub loader_calls: AtomicU32,
    pub job_calls: AtomicU32,
    /// The last `loader` request received (parsed).
    pub last_loader: Mutex<Option<Value>>,
    /// The last `jobs` request received (parsed).
    pub last_jobs: Mutex<Option<Value>>,
    /// `fetch` request JSON → the A2 frame bytes ([`FakeBun::with_fetch`]).
    pub fetch: Option<FetchResponder>,
    pub fetch_calls: AtomicU32,
    /// The last `fetch` request received (parsed).
    pub last_fetch: Mutex<Option<Value>>,
    /// F82: the heap request body of the last `fetch` call that carried `body: {"heap": n}`.
    pub last_fetch_body: Mutex<Option<Vec<u8>>>,
    /// F82: the `max_response_bytes` the fake's "worker" reports when `put_fetch_reply` declines.
    resp_cap: AtomicUsize,
    /// When set, every call is counted and recorded but its future never resolves.
    pub never_complete: bool,
    /// When set, a call parks until [`Gate::settle_all`], then writes its reply
    /// into the slot and resolves (a late settle).
    gate: Option<tokio::sync::watch::Receiver<bool>>,
    /// The server and worker id this fake plans for ([`FakeBun::bind`]).
    bound: OnceLock<(Weak<Server>, u32)>,
    /// Runs between `plan_in_call` and the reply ([`FakeBun::with_after_plan`]).
    after_plan: Option<Box<dyn Fn() + Send + Sync>>,
    ptr: *mut u8,
    len: usize,
}

// SAFETY: the buffer is leaked (process-global) and only written for the slot
// whose claim the caller holds; same justification as `MockDispatch` and the
// production `BufPtr`.
unsafe impl Send for FakeBun {}
unsafe impl Sync for FakeBun {}

impl FakeBun {
    pub fn new(
        loader: impl Fn(Value) -> Value + Send + Sync + 'static,
        jobs: impl Fn(Value) -> Value + Send + Sync + 'static,
    ) -> Arc<Self> {
        Self::with(loader, jobs, false)
    }

    /// Like [`FakeBun::new`] with an explicit `never_complete` flag.
    pub fn with(
        loader: impl Fn(Value) -> Value + Send + Sync + 'static,
        jobs: impl Fn(Value) -> Value + Send + Sync + 'static,
        never_complete: bool,
    ) -> Arc<Self> {
        let b = vec![0u8; 256 * 1024].into_boxed_slice();
        let len = b.len();
        let ptr = Box::leak(b).as_mut_ptr();
        Arc::new(Self {
            loader: Box::new(loader),
            jobs: Box::new(jobs),
            loader_calls: AtomicU32::new(0),
            job_calls: AtomicU32::new(0),
            last_loader: Mutex::new(None),
            last_jobs: Mutex::new(None),
            fetch: None,
            fetch_calls: AtomicU32::new(0),
            last_fetch: Mutex::new(None),
            last_fetch_body: Mutex::new(None),
            resp_cap: AtomicUsize::new(8_388_608),
            never_complete,
            gate: None,
            bound: OnceLock::new(),
            after_plan: None,
            ptr,
            len,
        })
    }

    /// Like [`FakeBun::new`], but every call parks until the returned [`Gate`]
    /// settles it, then replies normally.
    pub fn gated(
        loader: impl Fn(Value) -> Value + Send + Sync + 'static,
        jobs: impl Fn(Value) -> Value + Send + Sync + 'static,
    ) -> (Arc<Self>, Gate) {
        let (tx, rx) = tokio::sync::watch::channel(false);
        let mut b = Arc::into_inner(Self::with(loader, jobs, false)).expect("fresh Arc");
        b.gate = Some(rx);
        (Arc::new(b), Gate(tx))
    }

    /// `(loader_calls, job_calls)`.
    pub fn counts(&self) -> (u32, u32) {
        (
            self.loader_calls.load(Ordering::SeqCst),
            self.job_calls.load(Ordering::SeqCst),
        )
    }

    pub fn last_loader(&self) -> Option<Value> {
        self.last_loader.lock().unwrap().clone()
    }

    pub fn last_jobs(&self) -> Option<Value> {
        self.last_jobs.lock().unwrap().clone()
    }

    /// `fetch` calls received.
    pub fn fetch_count(&self) -> u32 {
        self.fetch_calls.load(Ordering::SeqCst)
    }

    pub fn last_fetch(&self) -> Option<Value> {
        self.last_fetch.lock().unwrap().clone()
    }

    /// F82: the heap request body of the last `fetch` call that carried one.
    pub fn last_fetch_body(&self) -> Option<Vec<u8>> {
        self.last_fetch_body.lock().unwrap().clone()
    }

    /// F82: the cap named in the fake worker's 500 when `put_fetch_reply` declines.
    pub fn set_response_cap(&self, n: usize) {
        self.resp_cap.store(n, Ordering::SeqCst);
    }

    /// F82: the worker id this fake is bound to.
    pub fn worker_id(&self) -> u32 {
        self.bound.get().expect("FakeBun not bound").1
    }

    /// Answers `fetch` calls with `f(request)` — the A2 frame bytes, written into the slot as is.
    pub fn with_fetch(
        self: Arc<Self>,
        f: impl Fn(Value) -> Vec<u8> + Send + Sync + 'static,
    ) -> Arc<Self> {
        let mut b = Arc::into_inner(self).expect("with_fetch before the fake is shared");
        b.fetch = Some(Box::new(f));
        Arc::new(b)
    }

    /// Take the plan offer of `loader` requests (`plan: true`) like the real worker: write the
    /// loader response into the slot, `plan_in_call`, run the misses, answer `{planned, results}`.
    pub fn bind(&self, s: &Arc<Server>, worker: u32) {
        let _ = self.bound.set((Arc::downgrade(s), worker));
    }

    /// Runs between `plan_in_call` and the reply (tests of the plan-to-render window).
    pub fn with_after_plan(self: Arc<Self>, f: impl Fn() + Send + Sync + 'static) -> Arc<Self> {
        let mut b = Arc::into_inner(self).expect("with_after_plan before the fake is shared");
        b.after_plan = Some(Box::new(f));
        Arc::new(b)
    }

    /// The `slot` sub-region of the leaked buffer.
    fn buf_slot(&self, slot: u32) -> (*mut u8, usize) {
        FakeBunHandle::slot_of(self.ptr, self.len, slot)
    }

    /// Write `bytes` into `slot` (the caller holds its claim).
    fn write(&self, slot: u32, bytes: &[u8]) {
        let (dst, cap) = self.buf_slot(slot);
        assert!(
            bytes.len() <= cap,
            "FakeBun: response {} > slot cap {cap}",
            bytes.len()
        );
        // SAFETY: `dst` is the in-bounds sub-region for `slot` (cap checked above)
        // and the caller holds that slot's claim, so nothing else writes it.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len()) };
    }

    /// F82: a `fetch` call like the real worker's: take the heap request body (recorded), and
    /// when the responder's frame does not fit the slot, `put_fetch_reply` its body and answer a
    /// frame whose meta gains `heap` and whose body is empty (a declined put answers the 500).
    fn reply_fetch(&self, req: Value, slot: u32) -> Vec<u8> {
        let bound = self
            .bound
            .get()
            .and_then(|(w, id)| w.upgrade().map(|s| (s, *id)));
        if req["body"]["heap"].is_number()
            && let Some((s, id)) = &bound
        {
            *self.last_fetch_body.lock().unwrap() = brust_server::take_fetch_body(s, *id, slot);
        }
        let out = (self.fetch.as_ref().expect("FakeBun: no fetch responder"))(req);
        let (_, cap) = self.buf_slot(slot);
        if out.len() <= cap {
            return out;
        }
        let (s, id) = bound.expect("FakeBun: an over-slot reply needs a bound fake");
        let n = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        let mut meta: Value = serde_json::from_slice(&out[4..4 + n]).expect("meta JSON");
        let body = &out[4 + n..];
        if !brust_server::put_fetch_reply(&s, id, slot, body) {
            let msg = format!(
                "brust: action response exceeds {} bytes",
                self.resp_cap.load(Ordering::SeqCst)
            );
            return super::frame(
                500,
                &[("content-type", "text/plain; charset=utf-8")],
                msg.as_bytes(),
            );
        }
        meta["heap"] = json!(body.len());
        let meta = serde_json::to_vec(&meta).unwrap();
        let mut f = (meta.len() as u32).to_le_bytes().to_vec();
        f.extend_from_slice(&meta);
        f
    }

    /// The reply bytes for one call (written into the slot by the caller). A bound fake takes
    /// a `loader` plan offer when its loader answers `ok: true` data.
    fn reply(&self, kind: CallKind, req: Value, slot: u32) -> Vec<u8> {
        let respond = match kind {
            CallKind::Loader => &self.loader,
            CallKind::Jobs => &self.jobs,
            CallKind::Fetch => return self.reply_fetch(req, slot),
        };
        let resp = respond(req.clone());
        if kind == CallKind::Loader
            && req["plan"] == true
            && resp["ok"] == true
            && let Some((s, id)) = self
                .bound
                .get()
                .and_then(|(w, id)| w.upgrade().map(|s| (s, *id)))
        {
            let first = serde_json::to_vec(&resp).expect("FakeBun: response serialises");
            self.write(slot, &first);
            let misses = brust_server::plan_in_call(&s, id, slot, first.len() as u32);
            if misses == brust_server::PLAN_DECLINED {
                return first;
            }
            let results = if misses.is_empty() {
                json!([])
            } else {
                let jr: Value = serde_json::from_str(&misses).expect("misses are JSON");
                self.job_calls.fetch_add(1, Ordering::SeqCst);
                *self.last_jobs.lock().unwrap() = Some(jr.clone());
                let r = (self.jobs)(jr);
                if r.get("error").is_some() {
                    // The real worker's catch: the batch failed as a whole, the slot gets {error}.
                    return serde_json::to_vec(&json!({"error": r["error"]}))
                        .expect("FakeBun: response serialises");
                }
                r["results"].clone()
            };
            if let Some(f) = &self.after_plan {
                f();
            }
            return serde_json::to_vec(&json!({"planned": true, "results": results}))
                .expect("FakeBun: response serialises");
        }
        serde_json::to_vec(&resp).expect("FakeBun: response serialises")
    }
}

/// `impl RenderDispatch for Arc<FakeBun>` is not possible (orphan rule), so tests
/// register `Box::new(FakeBunHandle(Arc::clone(&fake)))` and keep the `Arc` to
/// read counts. The handle owns the dispatch: a parked (gated) call needs the
/// `Arc` to build its reply once the gate opens.
pub struct FakeBunHandle(pub Arc<FakeBun>);

impl FakeBunHandle {
    fn slot_of(base: *mut u8, total: usize, slot: u32) -> (*mut u8, usize) {
        // One slot (the `RenderDispatch::slot_count` default): the whole buffer.
        assert_eq!(slot, 0, "FakeBun has one slot");
        (base, total)
    }
}

impl RenderDispatch for FakeBunHandle {
    fn call(
        &self,
        kind: CallKind,
        request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
        let f = &self.0;
        let req: Value = serde_json::from_str(&request_json).expect("FakeBun: request is JSON");
        let (counter, last) = match kind {
            CallKind::Loader => (&f.loader_calls, &f.last_loader),
            CallKind::Jobs => (&f.job_calls, &f.last_jobs),
            CallKind::Fetch => (&f.fetch_calls, &f.last_fetch),
        };
        counter.fetch_add(1, Ordering::SeqCst);
        *last.lock().unwrap() = Some(req.clone());
        if f.never_complete {
            return Box::pin(std::future::pending());
        }
        if let Some(mut gate) = f.gate.clone() {
            // Parked: the reply is built and written only when the gate opens, as a
            // real worker settling late would (the claim is held until this settles).
            let f = Arc::clone(f);
            return Box::pin(async move {
                let _ = gate.wait_for(|open| *open).await;
                let bytes = f.reply(kind, req, slot);
                f.write(slot, &bytes);
                Ok(bytes.len() as u32)
            });
        }
        let bytes = f.reply(kind, req, slot);
        f.write(slot, &bytes);
        let len = bytes.len() as u32;
        Box::pin(async move { Ok(len) })
    }

    fn buf(&self) -> (*mut u8, usize) {
        (self.0.ptr, self.0.len)
    }
}

/// Opens every parked call of a [`FakeBun::gated`] double.
pub struct Gate(tokio::sync::watch::Sender<bool>);

impl Gate {
    pub fn settle_all(&self) {
        let _ = self.0.send(true);
    }
}
