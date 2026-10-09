//! `FakeBun`: an in-process [`RenderDispatch`] standing in for the Bun worker.
//! It parses the inline request JSON, counts calls per [`CallKind`], records the
//! last request of each kind, and writes the canned JSON response into its SAB
//! slot exactly as the real worker does.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use brust_server::dispatch::{CallKind, DispatchError, RenderDispatch};
use serde_json::Value;

type Responder = Box<dyn Fn(Value) -> Value + Send + Sync>;

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
    /// When set, every call is counted and recorded but its future never resolves.
    pub never_complete: bool,
    /// When set, a call parks until [`Gate::settle_all`], then writes its reply
    /// into the slot and resolves (a late settle).
    gate: Option<tokio::sync::watch::Receiver<bool>>,
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
            never_complete,
            gate: None,
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
}

impl RenderDispatch for FakeBun {
    fn call(
        &self,
        kind: CallKind,
        request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
        let req: Value = serde_json::from_str(&request_json).expect("FakeBun: request is JSON");
        let (counter, last, respond) = match kind {
            CallKind::Loader => (&self.loader_calls, &self.last_loader, &self.loader),
            CallKind::Jobs => (&self.job_calls, &self.last_jobs, &self.jobs),
        };
        counter.fetch_add(1, Ordering::SeqCst);
        *last.lock().unwrap() = Some(req.clone());
        if self.never_complete {
            return Box::pin(std::future::pending());
        }
        let bytes = serde_json::to_vec(&respond(req)).expect("FakeBun: response serialises");
        let (dst, cap) = self.buf_slot(slot);
        assert!(
            bytes.len() <= cap,
            "FakeBun: response {} > slot cap {cap}",
            bytes.len()
        );
        // `dst` is the in-bounds sub-region for `slot` (cap checked above) and
        // the caller holds that slot's claim, so nothing else writes it.
        let len = bytes.len() as u32;
        if let Some(mut gate) = self.gate.clone() {
            // Parked: the reply is written only when the gate opens, as a real
            // worker settling late would.
            let (dst, bytes) = (dst as usize, bytes);
            return Box::pin(async move {
                let _ = gate.wait_for(|open| *open).await;
                // SAFETY: as above; the claim is held until this future settles.
                unsafe {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst as *mut u8, bytes.len())
                };
                Ok(len)
            });
        }
        // SAFETY: `dst` is in bounds and the claim is held (see above).
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len()) };
        Box::pin(async move { Ok(len) })
    }

    fn buf(&self) -> (*mut u8, usize) {
        (self.ptr, self.len)
    }
}

/// `impl RenderDispatch for Arc<FakeBun>` is not possible (orphan rule), so tests
/// register `Box::new(FakeBunHandle(Arc::clone(&fake)))` and keep the `Arc` to
/// read counts.
pub struct FakeBunHandle(pub Arc<FakeBun>);

impl RenderDispatch for FakeBunHandle {
    fn call(
        &self,
        kind: CallKind,
        request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
        self.0.call(kind, request_json, slot)
    }

    fn slot_count(&self) -> usize {
        self.0.slot_count()
    }

    fn buf(&self) -> (*mut u8, usize) {
        self.0.buf()
    }
}

/// Opens every parked call of a [`FakeBun::gated`] double.
pub struct Gate(tokio::sync::watch::Sender<bool>);

impl Gate {
    pub fn settle_all(&self) {
        let _ = self.0.send(true);
    }
}
