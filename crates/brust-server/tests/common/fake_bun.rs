//! `FakeBun`: an in-process [`RenderDispatch`] standing in for the Bun worker.
//! It parses the inline request JSON, counts calls per [`CallKind`], records the
//! last request of each kind, and writes the canned JSON response into its SAB
//! slot exactly as the real worker does (a `fetch` responder returns the A2
//! frame bytes itself, [`super::frame`]). Bound to its server ([`FakeBun::bind`],
//! done by `boot*`), it takes the plan offer of `loader` requests like the real
//! worker (M3-P P6). Counts are (loader runs, job batches) — a planned call
//! counts one of each, as the two-call path did.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

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
    /// L10: bound, but never takes the plan offer (the two-call path), so `jobs` is its own call.
    no_plan: bool,
    /// The server and worker id this fake plans for ([`FakeBun::bind`]).
    bound: OnceLock<(Weak<Server>, u32)>,
    /// Runs between `plan_in_call` and the reply ([`FakeBun::with_after_plan`]).
    after_plan: Option<Box<dyn Fn() + Send + Sync>>,
    /// The cache adapter `cache` calls go to ([`FakeBun::with_l2`]); shared across fakes.
    pub l2: Option<Arc<FakeL2>>,
    pub cache_calls: AtomicU32,
    pub last_cache: Mutex<Option<Value>>,
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
            no_plan: false,
            bound: OnceLock::new(),
            after_plan: None,
            l2: None,
            cache_calls: AtomicU32::new(0),
            last_cache: Mutex::new(None),
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

    /// Bound (so it can hand over heap replies) but declining every plan offer: the two-call path.
    pub fn declining_plan(self: Arc<Self>) -> Arc<Self> {
        let mut b = Arc::into_inner(self).expect("declining_plan before the fake is shared");
        b.no_plan = true;
        Arc::new(b)
    }

    /// Runs between `plan_in_call` and the reply (tests of the plan-to-render window).
    pub fn with_after_plan(self: Arc<Self>, f: impl Fn() + Send + Sync + 'static) -> Arc<Self> {
        let mut b = Arc::into_inner(self).expect("with_after_plan before the fake is shared");
        b.after_plan = Some(Box::new(f));
        Arc::new(b)
    }

    /// Answers `cache` calls from `l2` (several fakes may share one: two servers, one store).
    pub fn with_l2(self: Arc<Self>, l2: Arc<FakeL2>) -> Arc<Self> {
        let mut b = Arc::into_inner(self).expect("with_l2 before the fake is shared");
        b.l2 = Some(l2);
        Arc::new(b)
    }

    /// `cache` calls received.
    pub fn cache_count(&self) -> u32 {
        self.cache_calls.load(Ordering::SeqCst)
    }

    pub fn last_cache(&self) -> Option<Value> {
        self.last_cache.lock().unwrap().clone()
    }

    /// A `cache` call like the real bridge's (`runCache`): `get` answers a framed hit, a heap hit
    /// (`put_fetch_reply`) when it does not fit the slot, or a miss; `set` takes the body
    /// (`take_fetch_body`) and applies the store's stale guard.
    fn reply_cache(&self, req: Value, slot: u32) -> Vec<u8> {
        let l2 = self.l2.as_ref().expect("FakeBun: no l2");
        let bound = self
            .bound
            .get()
            .and_then(|(w, id)| w.upgrade().map(|s| (s, *id)));
        let meta_frame = |meta: Value, body: &[u8]| {
            let meta = serde_json::to_vec(&meta).unwrap();
            let mut f = (meta.len() as u32).to_le_bytes().to_vec();
            f.extend_from_slice(&meta);
            f.extend_from_slice(body);
            f
        };
        if l2.fail_next.swap(false, Ordering::SeqCst) {
            return meta_frame(json!({"error": "fake l2 failure"}), b"");
        }
        let mut st = l2.state.lock().unwrap();
        match req["op"].as_str() {
            Some("get") => {
                st.gets += 1;
                let key = req["key"].as_str().unwrap();
                let seq = st.seq;
                let Some(e) = st.map.get(key) else {
                    return meta_frame(json!({"hit": false, "stamp": seq}), b"");
                };
                let meta = json!({"hit": true, "status": e.status, "headers": e.headers,
                    "stamp": seq, "entryStamp": e.entry_stamp, "storedAt": e.stored_at});
                let body = e.body.clone();
                drop(st);
                let f = meta_frame(meta.clone(), &body);
                let (_, cap) = self.buf_slot(slot);
                if f.len() <= cap {
                    return f;
                }
                let (s, id) = bound.expect("FakeBun: a heap cache hit needs a bound fake");
                if !brust_server::put_fetch_reply(&s, id, slot, &body) {
                    return meta_frame(json!({"hit": false, "stamp": seq}), b"");
                }
                let mut meta = meta;
                meta["heap"] = json!(body.len());
                meta_frame(meta, b"")
            }
            Some("set") => {
                st.sets += 1;
                let (s, id) = bound.expect("FakeBun: a cache set needs a bound fake");
                let body = brust_server::take_fetch_body(&s, id, slot).expect("set body");
                assert_eq!(
                    Some(body.len() as u64),
                    req["heap"].as_u64(),
                    "set heap length"
                );
                let m = &req["meta"];
                let tags: Vec<String> = serde_json::from_value(m["tags"].clone()).unwrap();
                let stamp = m["stamp"].as_u64();
                if let Some(stamp) = stamp
                    && tags
                        .iter()
                        .any(|t| st.tag_inval.get(t).is_some_and(|&q| q > stamp))
                {
                    return meta_frame(json!({"ok": false}), b"");
                }
                st.map.insert(
                    req["key"].as_str().unwrap().to_owned(),
                    FakeEntry {
                        status: req["status"].as_u64().unwrap() as u16,
                        headers: serde_json::from_value(req["headers"].clone()).unwrap(),
                        body,
                        tags,
                        entry_stamp: stamp,
                        stored_at: now_ms(),
                    },
                );
                meta_frame(json!({"ok": true}), b"")
            }
            op => panic!("FakeBun: unknown cache op {op:?}"),
        }
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

    /// L10: `bytes` as the real worker writes a loader/jobs reply: inline when it fits the slot, else
    /// handed over with `put_fetch_reply` and answered as the 5-byte marker `[0x00][u32 LE n]`
    /// (a declined put, or an unbound fake, answers the slot-size `{error}`).
    fn slot_or_heap(&self, bytes: Vec<u8>, slot: u32) -> Vec<u8> {
        let (_, cap) = self.buf_slot(slot);
        if bytes.len() <= cap {
            return bytes;
        }
        let bound = self
            .bound
            .get()
            .and_then(|(w, id)| w.upgrade().map(|s| (s, *id)));
        if let Some((s, id)) = bound
            && brust_server::put_fetch_reply(&s, id, slot, &bytes)
        {
            let mut m = vec![0u8];
            m.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            return m;
        }
        serde_json::to_vec(
            &json!({"error": format!("response too large: {} > {cap}", bytes.len())}),
        )
        .expect("FakeBun: response serialises")
    }

    /// The reply bytes for one call (written into the slot by the caller). A bound fake takes
    /// a `loader` plan offer when its loader answers `ok: true` data.
    fn reply(&self, kind: CallKind, req: Value, slot: u32) -> Vec<u8> {
        let respond = match kind {
            CallKind::Loader => &self.loader,
            CallKind::Jobs => &self.jobs,
            CallKind::Fetch => return self.reply_fetch(req, slot),
            CallKind::Cache => return self.reply_cache(req, slot),
        };
        let resp = respond(req.clone());
        if kind == CallKind::Loader
            && req["plan"] == true
            && resp["ok"] == true
            && !self.no_plan
            && let Some((s, id)) = self
                .bound
                .get()
                .and_then(|(w, id)| w.upgrade().map(|s| (s, *id)))
        {
            let first = serde_json::to_vec(&resp).expect("FakeBun: response serialises");
            let (_, cap) = self.buf_slot(slot);
            let misses = if first.len() <= cap {
                self.write(slot, &first);
                brust_server::plan_in_call(&s, id, slot, first.len() as u32)
            } else {
                // L10: a ctx too large for the slot is planned from the bytes.
                brust_server::plan_in_call_buf(&s, id, slot, &first)
            };
            if misses == brust_server::PLAN_DECLINED {
                return self.slot_or_heap(first, slot);
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
            return self.slot_or_heap(
                serde_json::to_vec(&json!({"planned": true, "results": results}))
                    .expect("FakeBun: response serialises"),
                slot,
            );
        }
        self.slot_or_heap(
            serde_json::to_vec(&resp).expect("FakeBun: response serialises"),
            slot,
        )
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
            CallKind::Cache => (&f.cache_calls, &f.last_cache),
        };
        counter.fetch_add(1, Ordering::SeqCst);
        *last.lock().unwrap() = Some(req.clone());
        if f.never_complete {
            return Box::pin(std::future::pending());
        }
        // A hung `get`: the reply comes late (the real bridge's own timer settles it), so the
        // request's `get_timeout` fires first and the slot stays claimed until then.
        if kind == CallKind::Cache
            && req["op"] == "get"
            && f.l2
                .as_ref()
                .is_some_and(|l| l.hang_next_get.swap(false, Ordering::SeqCst))
        {
            let f = Arc::clone(f);
            return Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let bytes = f.reply(kind, req, slot);
                f.write(slot, &bytes);
                Ok(bytes.len() as u32)
            });
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

/// One stored page of a [`FakeL2`].
pub struct FakeEntry {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub tags: Vec<String>,
    pub entry_stamp: Option<u64>,
    pub stored_at: u64,
}

#[derive(Default)]
pub struct FakeL2State {
    pub map: HashMap<String, FakeEntry>,
    /// The broadcast seq (`stamp` of every get).
    pub seq: u64,
    /// Per tag: the seq of its last invalidation (the stale-write guard).
    pub tag_inval: HashMap<String, u64>,
    pub gets: u32,
    pub sets: u32,
}

/// An in-test cache adapter store with the exact stale guard of the real ones.
#[derive(Default)]
pub struct FakeL2 {
    pub state: Mutex<FakeL2State>,
    pub hang_next_get: std::sync::atomic::AtomicBool,
    pub fail_next: std::sync::atomic::AtomicBool,
}

impl FakeL2 {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// `store.invalidate({tags:[tag]})` + its publish: the next seq, marker, delete.
    pub fn invalidate_tag(&self, tag: &str) {
        let mut st = self.state.lock().unwrap();
        st.seq += 1;
        let seq = st.seq;
        st.tag_inval.insert(tag.to_owned(), seq);
        st.map.retain(|_, e| !e.tags.iter().any(|t| t == tag));
    }

    /// Put a page directly (a body another server wrote).
    pub fn put(&self, key: &str, e: FakeEntry) {
        self.state.lock().unwrap().map.insert(key.to_owned(), e);
    }

    pub fn len(&self) -> usize {
        self.state.lock().unwrap().map.len()
    }

    /// `(gets, sets)` answered.
    pub fn ops(&self) -> (u32, u32) {
        let st = self.state.lock().unwrap();
        (st.gets, st.sets)
    }
}

/// Wall-clock ms (an entry's `storedAt`).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
