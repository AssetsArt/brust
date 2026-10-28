use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::task::Waker;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use tokio::sync::mpsc;

use crate::dispatch::RenderDispatch;

/// One chunk delivered from a worker's `napi_render_chunk` call to handle_conn's
/// per-request chunk loop. `ack` resolves the worker's awaiting Promise so the
/// next chunk can be written into the SAB without overlapping.
pub enum RenderChunk {
    /// Chunk body (first chunk includes meta prefix per spec S4).
    Bytes {
        data: Vec<u8>,
        ack: tokio::sync::oneshot::Sender<()>,
    },
    /// `napi_render_chunk(_, 0)` — close the channel, terminate the response.
    Final {
        ack: tokio::sync::oneshot::Sender<()>,
    },
    /// Combined Bytes + Final. Buffering-path callers use this to eliminate
    /// one tsfn round-trip per render. handle_conn processes this as the
    /// byte-equivalent of Bytes-then-Final consecutive sends.
    BytesAndFinal {
        data: Vec<u8>,
        ack: tokio::sync::oneshot::Sender<()>,
    },
}

/// Per-worker per-request slot. Installed atomically by
/// `WorkerPool::try_claim_render` BEFORE calling `tsfn.call_async`;
/// cleared by `RenderClaim::drop` on exit (RAII — survives panic,
/// cancellation, early returns).
pub struct RenderSlot {
    pub chunk_tx: mpsc::Sender<RenderChunk>,
}

/// The type-erased in-call plan state a slot carries (M3-P P6): in production a
/// `pipeline::PlanCell`; boxed as `Any` so the pool stays pipeline-free.
pub type PlanBox = Box<dyn std::any::Any + Send>;

/// One render slot of a worker. A worker holds `K` of these (K = the
/// dispatch's `slot_count()`); each slot is an independent in-flight render
/// reservation backed by a disjoint SAB sub-region (see `RenderDispatch::buf_slot`).
pub struct Slot {
    /// Per-slot exclusivity gate, SAME polarity as the old per-worker `idle`:
    /// true = free. Claim = CAS true→false (Acquire); RenderClaim::drop restores
    /// true (Release). (Was a single per-worker AtomicBool; now one per slot.)
    idle: AtomicBool,
    /// Per-slot chunk sender, stored on claim for the streaming path; cleared on
    /// drop. (Was the single per-worker render_slot Mutex.)
    render_slot: parking_lot::Mutex<Option<RenderSlot>>,
    /// M3-P P6: the in-call plan state of the request holding this slot
    /// (`pipeline::PlanCell`, type-erased so the pool stays pipeline-free). Put by
    /// `RenderClaim::put_plan` (tokio, after the claim, before the call), swapped by
    /// `pipeline::plan_in_call` (the worker's JS thread, during the call), taken by
    /// `RenderClaim::take_plan` after the Promise resolved. ALWAYS cleared by
    /// `RenderClaim::drop`: no plan outlives its claim (deadline, disconnect, panic).
    pub(crate) plan: parking_lot::Mutex<Option<PlanBox>>,
    /// M3-P P6: when `plan_in_call` handed this claim's call its job misses — the start of
    /// the jobs phase inside a planned call, which `call_worker_planned` times like the old
    /// separate jobs call. Cleared with the plan by `RenderClaim::drop`.
    jobs_since: parking_lot::Mutex<Option<std::time::Instant>>,
    /// M3-P P7 (R3): the current claim's call deadline, for the pool's sweeper — ms since
    /// [`EPOCH`], rounded up; 0 = not armed. Armed by `call_worker_planned` while it holds the
    /// claim, disarmed by `RenderClaim::drop` before the slot is released.
    deadline_ms: AtomicU64,
    /// The waker of the call waiting on that deadline. Per slot and uncontended: only the claim
    /// holder and the sweeper touch it.
    deadline_waker: parking_lot::Mutex<Option<Waker>>,
    /// L10: a loader/jobs/planned reply too large for the SAB slot, put by the worker
    /// (`put_fetch_reply`) before it writes the 5-byte heap marker `[0x00][u32 LE n]` into the slot;
    /// taken by [`RenderClaim::take_heap_reply`] inside the claim. ALWAYS cleared by
    /// `RenderClaim::drop`: no reply outlives its claim.
    pub(crate) heap_reply: parking_lot::Mutex<Option<bytes::Bytes>>,
}

/// The origin of [`Slot`] deadlines (process-wide, so a slot needs no pool back-reference).
static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// `at` as ms since [`EPOCH`], rounded up (so the sweeper never wakes a call early), never 0.
fn epoch_ms_ceil(at: Instant) -> u64 {
    let d = at.saturating_duration_since(*EPOCH);
    (d.as_micros().div_ceil(1000) as u64).max(1)
}

/// How often the pool's sweeper looks for expired call deadlines (R3: a deadline fires within
/// one tick after it passed).
pub const SWEEP_TICK: Duration = Duration::from_millis(10);

impl Slot {
    /// Per-slot exclusivity gate (`true` = free). Exposed for assertions in the
    /// render-path tests that previously read the per-worker `idle`.
    pub fn is_idle(&self) -> bool {
        self.idle.load(Ordering::Acquire)
    }

    /// Per-slot chunk-sender mutex. Exposed for assertions that previously read
    /// the per-worker `render_slot`.
    pub fn render_slot(&self) -> &parking_lot::Mutex<Option<RenderSlot>> {
        &self.render_slot
    }
}

pub struct WorkerEntry {
    pub(crate) id: u32,
    /// The render bridge for this worker. In production this is a
    /// `crate::dispatch_impl::TsfnDispatch` (napi tsfn + SAB pointer); tests
    /// use `crate::render::dispatch::MockDispatch`. The seam keeps all napi
    /// out of this module. `pub` because the napi binding reads `entry.dispatch`
    /// for the SAB buf/buf_slot in the render-chunk/jinja paths.
    pub dispatch: Box<dyn RenderDispatch>,
    pub(crate) in_flight: AtomicU32,
    /// The worker's `K` render slots (K = `dispatch.slot_count()`). Each holds a
    /// per-slot `idle` gate + per-slot `render_slot` mutex. Replaces the single
    /// per-worker `idle` + `render_slot` pair.
    pub(crate) slots: Vec<Slot>,
}

impl WorkerEntry {
    pub fn in_flight_guard(self: &Arc<Self>) -> InFlightGuard {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        InFlightGuard(Arc::clone(self))
    }

    /// Borrow the `i`th render slot. Used by tests asserting per-slot state.
    pub fn slot(&self, i: usize) -> &Slot {
        &self.slots[i]
    }

    /// Number of render slots this worker holds.
    pub fn slot_len(&self) -> usize {
        self.slots.len()
    }

    /// This worker's pool id (the value `WorkerPool::register` returned).
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The per-slot `render_slot` mutex the napi `napi_render_chunk` paths pass
    /// to `check_chunk_dispatch`. Returns `None` if `slot` is out of range (a
    /// worker only has `slot_count()` slots) rather than panicking, so a bad
    /// slot from JS is a clean error instead of an abort.
    pub fn render_slot_for(&self, slot: u32) -> Option<&parking_lot::Mutex<Option<RenderSlot>>> {
        self.slots.get(slot as usize).map(|s| &s.render_slot)
    }

    /// `slot`'s plan cell while that slot is claimed; `None` when out of range or idle.
    /// Stamp the start of a planned call's jobs phase on a CLAIMED slot (no-op otherwise).
    pub fn stamp_jobs_phase(&self, slot: u32) {
        if let Some(s) = self.slots.get(slot as usize).filter(|s| !s.is_idle()) {
            *s.jobs_since.lock() = Some(std::time::Instant::now());
        }
    }

    /// The jobs-phase stamp of `slot`, if its current claim's call made one.
    pub(crate) fn jobs_phase_since(&self, slot: u32) -> Option<std::time::Instant> {
        self.slots
            .get(slot as usize)
            .and_then(|s| *s.jobs_since.lock())
    }

    /// Arm (or move) `slot`'s call deadline for the sweeper (M3-P P7). Only the claim holder calls it.
    pub(crate) fn arm_deadline(&self, slot: u32, at: Instant) {
        if let Some(s) = self.slots.get(slot as usize) {
            s.deadline_ms.store(epoch_ms_ceil(at), Ordering::Relaxed);
        }
    }

    /// Park the waker the sweeper wakes when `slot`'s armed deadline passes (M3-P P7).
    pub(crate) fn park_deadline_waker(&self, slot: u32, w: &Waker) {
        if let Some(s) = self.slots.get(slot as usize) {
            let mut g = s.deadline_waker.lock();
            if !g.as_ref().is_some_and(|old| old.will_wake(w)) {
                let old = g.replace(w.clone());
                drop(g);
                drop(old);
            }
        }
    }

    /// `slot` while it is claimed; `None` when out of range or idle.
    pub(crate) fn claimed_slot(&self, slot: u32) -> Option<&Slot> {
        self.slots.get(slot as usize).filter(|s| !s.is_idle())
    }

    pub fn claimed_plan_cell(&self, slot: u32) -> Option<&parking_lot::Mutex<Option<PlanBox>>> {
        self.slots
            .get(slot as usize)
            .filter(|s| !s.is_idle())
            .map(|s| &s.plan)
    }
}

pub struct InFlightGuard(Arc<WorkerEntry>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// RAII guard returned by `WorkerPool::try_claim_render`. Holds the per-
/// worker render slot + the in_flight counter for the lifetime of the
/// guard. Drop atomically clears both.
#[must_use = "RenderClaim must be held for the lifetime of the render; \
              dropping it immediately frees the worker and breaks the invariant"]
pub struct RenderClaim {
    entry: Arc<WorkerEntry>,
    /// Which of the worker's slots this claim reserves. The render path threads
    /// this into `dispatch.call(env, slot)` and `dispatch.buf_slot(slot)` so the
    /// worker writes its response into the matching SAB sub-region.
    slot: u32,
    /// `true` → claimed via the fast lane (no chunk_tx stored in render_slot);
    /// drop skips the mutex entirely. `false` → streaming claim; drop clears
    /// the slot under the mutex.
    lockfree: bool,
    /// Pool-wide "a worker just freed up" signal. Drop fires `notify_one` AFTER
    /// publishing `idle = true`, so a dispatcher waiting in `claim_or_wait`
    /// (AllBusy → await instead of 503) wakes and re-claims this worker.
    idle_notify: Arc<tokio::sync::Notify>,
}

impl RenderClaim {
    pub fn entry(&self) -> &Arc<WorkerEntry> {
        &self.entry
    }

    /// The reserved slot index. Copy `u32`; read it before the claim is moved
    /// into the chunk-pump task.
    pub fn slot(&self) -> u32 {
        self.slot
    }

    /// Put the request's plan state into this claim's slot cell (M3-P P6),
    /// replacing whatever it held. Called after the claim, before the call.
    pub fn put_plan(&self, v: PlanBox) {
        let old = self.entry.slots[self.slot as usize].plan.lock().replace(v);
        drop(old);
    }

    /// Take the heap reply the worker put for this claim's call (L10), once.
    pub fn take_heap_reply(&self) -> Option<bytes::Bytes> {
        self.entry.slots[self.slot as usize]
            .heap_reply
            .lock()
            .take()
    }

    /// Take whatever this claim's slot cell holds (M3-P P6). Called after the
    /// worker's Promise resolved, before the claim is dropped.
    pub fn take_plan(&self) -> Option<PlanBox> {
        self.entry.slots[self.slot as usize].plan.lock().take()
    }
}

impl Drop for RenderClaim {
    fn drop(&mut self) {
        // Release the `idle` gate LAST. Clearing the slot and decrementing
        // in_flight first, then publishing `idle = true` with Release, means the
        // next claimer's Acquire CAS observes a fully-clean worker — slot empty,
        // in_flight already decremented. (in_flight is a Relaxed load hint for
        // pick_least_busy; ordering it before the Release store avoids a
        // transient +1 skew where a new claim is taken before this decrement
        // lands.)
        //
        // INVARIANT (load-bearing): a slot must NOT be released here until its
        // render Promise has settled. Every dispatch path holds this RenderClaim
        // until after `promise.await` (fast lane) or until the chunk loop breaks
        // on the resolved future. The streaming path's client-disconnect case is
        // NOT an exception: instead of dropping the claim early, the chunk pump
        // DRAINS the worker (keeps ACKing chunks, discards bytes) and holds the
        // claim until the render future settles or a Final/BytesAndFinal arrives.
        // Do NOT add disconnect cancellation / timeouts to the render/action
        // dispatch without first gating release on Promise settlement: doing so
        // would let a recycled slot's new request write the SAB sub-region
        // concurrently with the old JS still touching it (data race).
        let slot = &self.entry.slots[self.slot as usize];
        // M3-P P6: no plan outlives its claim. The Box is dropped outside the lock.
        let stale = slot.plan.lock().take();
        drop(stale);
        slot.jobs_since.lock().take();
        let stale = slot.heap_reply.lock().take();
        drop(stale);
        // M3-P P7: disarm the call deadline before the slot can be claimed again.
        slot.deadline_ms.store(0, Ordering::Relaxed);
        let parked = slot.deadline_waker.lock().take();
        drop(parked);
        if !self.lockfree {
            slot.render_slot.lock().take();
        }
        self.entry.in_flight.fetch_sub(1, Ordering::Relaxed);
        slot.idle.store(true, Ordering::Release);
        // Wake one dispatcher parked in `claim_or_wait`. Fired AFTER the
        // `idle = true` Release store so the woken claimer's Acquire CAS sees
        // this worker idle. A missed wakeup (no waiter yet) is harmless: the
        // permit is stored, and `claim_or_wait` re-checks `try_claim` on every
        // loop iteration anyway, so the next waiter still claims this worker.
        self.idle_notify.notify_one();
    }
}

/// Outcome of `WorkerPool::try_claim_render`. Distinguishes "no workers
/// registered" from "every worker mid-render" so dispatchers can emit
/// different 503 bodies.
pub enum ClaimResult {
    Claimed(RenderClaim),
    PoolEmpty,
    AllBusy,
}

#[derive(Default)]
pub struct WorkerPool {
    /// M3-P P7 (R3): the deadline sweeper task is running (see [`WorkerPool::ensure_sweeper`]).
    sweeper_running: Arc<AtomicBool>,
    /// Every entry ever registered, as `Weak`: the sweeper walks THIS, not `entries`, so a call
    /// on a worker that `remove`/`clear` took out of the pool (dead worker, dev reload) still gets
    /// its deadline while its claim keeps the entry alive. Pruned by the sweeper.
    swept: parking_lot::Mutex<Vec<Weak<WorkerEntry>>>,
    entries: RwLock<Vec<Arc<WorkerEntry>>>,
    next_id: AtomicU32,
    /// Notified once per worker release (see `RenderClaim::drop`). Dispatchers
    /// that hit `AllBusy` await this instead of returning 503, letting
    /// conn-workers exceed render-workers without dropping requests.
    idle_notify: Arc<tokio::sync::Notify>,
}

impl WorkerPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, dispatch: Box<dyn RenderDispatch>) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        // Read the slot count BEFORE moving `dispatch` into the entry.
        let k = dispatch.slot_count().max(1);
        let slots: Vec<Slot> = (0..k)
            .map(|_| Slot {
                idle: AtomicBool::new(true),
                render_slot: parking_lot::Mutex::new(None),
                plan: parking_lot::Mutex::new(None),
                jobs_since: parking_lot::Mutex::new(None),
                deadline_ms: AtomicU64::new(0),
                deadline_waker: parking_lot::Mutex::new(None),
                heap_reply: parking_lot::Mutex::new(None),
            })
            .collect();
        let entry = Arc::new(WorkerEntry {
            id,
            dispatch,
            in_flight: AtomicU32::new(0),
            slots,
        });
        self.swept.lock().push(Arc::downgrade(&entry));
        self.entries.write().push(entry);
        id
    }

    /// A snapshot of the registered workers.
    pub(crate) fn entries(&self) -> Vec<Arc<WorkerEntry>> {
        self.entries.read().clone()
    }

    /// The render slots of every registered worker (F475's default `max_streams` is a quarter).
    pub(crate) fn slot_total(&self) -> usize {
        self.entries.read().iter().map(|e| e.slot_len()).sum()
    }

    /// Start the call-deadline sweeper on the current tokio runtime unless it runs (M3-P P7, R3):
    /// one task wakes every armed slot whose deadline passed, every [`SWEEP_TICK`], instead of a
    /// tokio timer per call. Started by the first armed call; it ends with the pool, and if its
    /// runtime drops it, the next armed call starts it again.
    pub(crate) fn ensure_sweeper(self: &Arc<Self>) {
        if self.sweeper_running.load(Ordering::Acquire)
            || self
                .sweeper_running
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        struct Running(Arc<AtomicBool>);
        impl Drop for Running {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let running = Running(Arc::clone(&self.sweeper_running));
        let pool: Weak<WorkerPool> = Arc::downgrade(self);
        tokio::spawn(async move {
            let _running = running;
            let mut iv = tokio::time::interval(SWEEP_TICK);
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut due: Vec<Waker> = Vec::new();
            loop {
                iv.tick().await;
                let Some(pool) = pool.upgrade() else { return };
                pool.collect_expired(Instant::now(), &mut due);
                drop(pool);
                for w in due.drain(..) {
                    w.wake();
                }
            }
        });
    }

    /// Take the parked waker of every armed slot whose deadline is at or before `now`. No lock is
    /// held when the caller wakes them.
    fn collect_expired(&self, now: Instant, due: &mut Vec<Waker>) {
        let now_ms = now.saturating_duration_since(*EPOCH).as_millis() as u64;
        let expired = |s: &Slot| {
            let d = s.deadline_ms.load(Ordering::Relaxed);
            d != 0 && d <= now_ms
        };
        let live: Vec<Arc<WorkerEntry>> = {
            let mut swept = self.swept.lock();
            let mut live = Vec::with_capacity(swept.len());
            swept.retain(|w| match w.upgrade() {
                Some(e) => {
                    live.push(e);
                    true
                }
                None => false,
            });
            live
        };
        for e in &live {
            for s in &e.slots {
                if expired(s) {
                    let mut g = s.deadline_waker.lock();
                    // Re-checked under the lock: the slot may have been released and re-armed.
                    if expired(s)
                        && let Some(w) = g.take()
                    {
                        due.push(w);
                    }
                }
            }
        }
    }

    pub fn registered_count(&self) -> usize {
        self.entries.read().len()
    }

    /// Pool-wide "worker freed" signal. `claim_or_wait` awaits this on AllBusy.
    pub fn idle_notify(&self) -> &Arc<tokio::sync::Notify> {
        &self.idle_notify
    }

    pub fn pick_least_busy(&self) -> Option<Arc<WorkerEntry>> {
        let entries = self.entries.read();
        entries
            .iter()
            .min_by_key(|e| e.in_flight.load(Ordering::Relaxed))
            .cloned()
    }

    /// Atomically reserve an idle render slot and install the chunk
    /// sender. Returns Claimed/PoolEmpty/AllBusy.
    ///
    /// Lock ordering: ALWAYS acquire `entries` (RwLock read) BEFORE the
    /// per-slot `render_slot` (Mutex). Inverting risks deadlock.
    pub fn try_claim_render(
        &self,
        chunk_tx: tokio::sync::mpsc::Sender<RenderChunk>,
    ) -> ClaimResult {
        let entries = self.entries.read();
        if entries.is_empty() {
            return ClaimResult::PoolEmpty;
        }
        for entry in entries.iter() {
            for (i, slot) in entry.slots.iter().enumerate() {
                // Lock-free exclusivity: CAS idle true→false. Acquire pairs with
                // the Release store in RenderClaim::drop so the next claimer sees
                // a clean slot. The mutex below is touched ONLY to store chunk_tx
                // (the streaming path needs it for napi_render_chunk).
                if slot
                    .idle
                    .compare_exchange(true, false, Ordering::Acquire, Ordering::Relaxed)
                    .is_err()
                {
                    continue;
                }
                entry.in_flight.fetch_add(1, Ordering::Relaxed);
                *slot.render_slot.lock() = Some(RenderSlot { chunk_tx });
                return ClaimResult::Claimed(RenderClaim {
                    entry: Arc::clone(entry),
                    slot: i as u32,
                    lockfree: false,
                    idle_notify: Arc::clone(&self.idle_notify),
                });
            }
        }
        ClaimResult::AllBusy
    }

    /// Fast-lane claim: reserve an idle slot via the lock-free `idle` CAS but
    /// do NOT store a chunk_tx (no mutex touched at all). For single-chunk
    /// dispatch (action/native) where the worker takes the fast lane and never
    /// calls `napi_render_chunk`. Drop releases `idle` without locking.
    pub fn try_claim_render_lockfree(&self) -> ClaimResult {
        let entries = self.entries.read();
        if entries.is_empty() {
            return ClaimResult::PoolEmpty;
        }
        for entry in entries.iter() {
            for (i, slot) in entry.slots.iter().enumerate() {
                if slot
                    .idle
                    .compare_exchange(true, false, Ordering::Acquire, Ordering::Relaxed)
                    .is_err()
                {
                    continue;
                }
                entry.in_flight.fetch_add(1, Ordering::Relaxed);
                return ClaimResult::Claimed(RenderClaim {
                    entry: Arc::clone(entry),
                    slot: i as u32,
                    lockfree: true,
                    idle_notify: Arc::clone(&self.idle_notify),
                });
            }
        }
        ClaimResult::AllBusy
    }

    pub fn entry(&self, id: u32) -> Option<Arc<WorkerEntry>> {
        self.entries.read().iter().find(|e| e.id == id).cloned()
    }

    pub fn remove(&self, id: u32) {
        self.entries.write().retain(|e| e.id != id);
    }

    /// Drop EVERY registered worker entry. Dev-mode hot reload calls this (via
    /// the `reset_worker_pool` napi export) from the main thread right BEFORE
    /// terminating the outgoing worker generation: each entry holds a `buf_ptr`
    /// into that worker's SharedArrayBuffer — which `Worker.terminate()` frees —
    /// plus a TSFN to its env. If the entries survived the respawn, the next
    /// request could pick a stale one and `serde_json::to_writer` the render
    /// envelope straight into freed SAB memory (use-after-free → SIGSEGV).
    /// Clearing while the workers are still alive also releases each TSFN
    /// against a live env. Any in-flight render keeps its entry alive through
    /// its own `Arc` clone, so this can't free an entry mid-dispatch. No-op in
    /// production (workers are registered once and never replaced).
    pub fn clear(&self) {
        self.entries.write().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::MockDispatch;
    use tokio::sync::{mpsc, oneshot};

    /// Register a worker backed by `MockDispatch` for pool-logic unit tests.
    fn register_for_test(pool: &WorkerPool) -> u32 {
        pool.register(Box::new(MockDispatch::new()))
    }

    /// Register a worker whose `MockDispatch` has `k` render slots.
    fn register_k_for_test(pool: &WorkerPool, k: usize) -> u32 {
        pool.register(Box::new(MockDispatch::with_slots(k)))
    }

    #[test]
    fn put_take_and_drop_clear_the_plan_cell() {
        let pool = WorkerPool::new();
        pool.register(Box::new(MockDispatch::with_slots(2)));
        let ClaimResult::Claimed(c) = pool.try_claim_render_lockfree() else {
            panic!("claim")
        };
        let entry = Arc::clone(c.entry());
        let slot = c.slot();
        assert!(
            entry.claimed_plan_cell(slot).is_some(),
            "a claimed slot exposes its cell"
        );
        assert!(
            entry.claimed_plan_cell(1 - slot).is_none(),
            "an idle slot does not"
        );
        assert!(entry.claimed_plan_cell(9).is_none(), "out of range");
        c.put_plan(Box::new(7u32));
        assert_eq!(*c.take_plan().unwrap().downcast::<u32>().unwrap(), 7);
        assert!(c.take_plan().is_none());
        c.put_plan(Box::new(8u32));
        drop(c); // never taken: the claim's drop clears it
        assert!(entry.slot(slot as usize).plan.lock().is_none());
    }

    #[test]
    fn render_slot_set_clear_round_trip() {
        let slot_mu: parking_lot::Mutex<Option<RenderSlot>> = parking_lot::Mutex::new(None);
        assert!(slot_mu.lock().is_none());
        let (tx, _rx) = mpsc::channel::<RenderChunk>(1);
        *slot_mu.lock() = Some(RenderSlot { chunk_tx: tx });
        assert!(slot_mu.lock().is_some());
        let taken = slot_mu.lock().take();
        assert!(taken.is_some());
        assert!(slot_mu.lock().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn render_chunk_enum_bytes_ack_round_trip() {
        let (tx, mut rx) = mpsc::channel::<RenderChunk>(1);
        let (ack_tx, ack_rx) = oneshot::channel::<()>();
        tx.send(RenderChunk::Bytes {
            data: vec![1, 2, 3],
            ack: ack_tx,
        })
        .await
        .unwrap();
        let got = rx.recv().await.unwrap();
        match got {
            RenderChunk::Bytes { data, ack } => {
                assert_eq!(data, vec![1, 2, 3]);
                ack.send(()).unwrap();
            }
            _ => panic!("expected Bytes variant"),
        }
        ack_rx.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn render_chunk_enum_final_ack_drop_returns_err() {
        let (ack_tx, ack_rx) = oneshot::channel::<()>();
        drop(ack_tx);
        assert!(ack_rx.await.is_err());
    }

    // Phase 2: dropping a RenderClaim fires `idle_notify` AND restores the
    // worker to claimable, so a dispatcher parked in claim_or_wait wakes and
    // re-claims instead of 503-ing. Mirrors the claim_or_wait register-then-await
    // ordering to prove no lost wakeup.
    #[tokio::test(flavor = "current_thread")]
    async fn drop_notifies_and_reclaims_after_all_busy() {
        let pool = WorkerPool::new();
        register_for_test(&pool);

        // Claim the only worker → pool now AllBusy.
        let claim = match pool.try_claim_render_lockfree() {
            ClaimResult::Claimed(c) => c,
            other => panic!("expected Claimed, got {:?}", DebugClaim(&other)),
        };
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::AllBusy
        ));

        // Register interest BEFORE releasing (claim_or_wait ordering).
        let notified = pool.idle_notify().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        drop(claim); // releases idle = true, then notify_one()

        // The wakeup must arrive...
        tokio::time::timeout(std::time::Duration::from_millis(500), notified.as_mut())
            .await
            .expect("idle_notify should fire on RenderClaim drop");
        // ...and the freed worker must be re-claimable.
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::Claimed(_)
        ));
    }

    // ClaimResult isn't Debug (holds a RenderClaim); tiny shim for the panic msg.
    struct DebugClaim<'a>(&'a ClaimResult);
    impl std::fmt::Debug for DebugClaim<'_> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(match self.0 {
                ClaimResult::Claimed(_) => "Claimed",
                ClaimResult::PoolEmpty => "PoolEmpty",
                ClaimResult::AllBusy => "AllBusy",
            })
        }
    }

    #[test]
    fn try_claim_render_returns_pool_empty() {
        let pool = WorkerPool::new();
        let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        match pool.try_claim_render(tx) {
            ClaimResult::PoolEmpty => {}
            _ => panic!("expected PoolEmpty"),
        }
    }

    #[test]
    fn try_claim_render_claims_idle_worker() {
        let pool = WorkerPool::new();
        let id = register_for_test(&pool);
        let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let claim = match pool.try_claim_render(tx) {
            ClaimResult::Claimed(c) => c,
            _ => panic!("expected Claimed"),
        };
        assert_eq!(claim.entry().id, id);
        assert!(claim.entry().slot(0).render_slot().lock().is_some());
        assert_eq!(claim.entry().in_flight.load(Ordering::Relaxed), 1);
        drop(claim);
    }

    #[test]
    fn try_claim_render_second_returns_other_idle_worker() {
        let pool = WorkerPool::new();
        let id0 = register_for_test(&pool);
        let id1 = register_for_test(&pool);
        let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);

        let c0 = match pool.try_claim_render(tx0) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
        let c1 = match pool.try_claim_render(tx1) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
        assert_ne!(c0.entry().id, c1.entry().id);
        let mut ids = [c0.entry().id, c1.entry().id];
        ids.sort();
        assert_eq!(ids, [id0, id1]);
    }

    #[test]
    fn try_claim_render_all_busy_returns_all_busy() {
        let pool = WorkerPool::new();
        let _id = register_for_test(&pool);
        let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let _c0 = match pool.try_claim_render(tx0) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
        match pool.try_claim_render(tx1) {
            ClaimResult::AllBusy => {}
            _ => panic!("expected AllBusy"),
        }
    }

    #[test]
    fn render_claim_drop_releases_slot_and_decrements_in_flight() {
        let pool = WorkerPool::new();
        let _id = register_for_test(&pool);
        let entry = pool.entries.read()[0].clone();
        {
            let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
            let _claim = match pool.try_claim_render(tx) {
                ClaimResult::Claimed(c) => c,
                _ => panic!(),
            };
            assert!(entry.slot(0).render_slot().lock().is_some());
            assert_eq!(entry.in_flight.load(Ordering::Relaxed), 1);
        }
        // Drop ran here.
        assert!(entry.slot(0).render_slot().lock().is_none());
        assert_eq!(entry.in_flight.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn clear_resets_pool_so_reload_does_not_accumulate() {
        // Models a dev hot reload: an N-worker generation is registered, the
        // reload clears it, then a fresh N-worker generation registers. The
        // pool must hold N entries afterwards — NOT 2N. Before `clear()`
        // existed, the stale generation survived (append-only `register`), and
        // a stale entry's dangling `buf_ptr` produced a UAF segfault on the
        // next render dispatch.
        let pool = WorkerPool::new();
        for _ in 0..4 {
            register_for_test(&pool);
        }
        assert_eq!(pool.registered_count(), 4);

        pool.clear();
        assert_eq!(pool.registered_count(), 0, "clear must drop every entry");

        for _ in 0..4 {
            register_for_test(&pool);
        }
        assert_eq!(
            pool.registered_count(),
            4,
            "after a reload the pool must hold N entries, not 2N (stale + fresh)",
        );
    }

    #[test]
    fn try_claim_render_after_drop_reuses_worker() {
        let pool = WorkerPool::new();
        let _id = register_for_test(&pool);
        let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        {
            let _c0 = match pool.try_claim_render(tx0) {
                ClaimResult::Claimed(c) => c,
                _ => panic!(),
            };
        }
        match pool.try_claim_render(tx1) {
            ClaimResult::Claimed(_) => {}
            _ => panic!("expected reuse"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn try_claim_render_race_no_concurrent_double_claim() {
        use std::sync::Arc;
        use tokio::sync::Barrier;

        const M: usize = 4; // workers
        const N: usize = 16; // concurrent claim attempts

        let pool = Arc::new(WorkerPool::new());
        for _ in 0..M {
            register_for_test(&pool);
        }

        // start_barrier: every task waits here before calling try_claim_render —
        //                forces simultaneous contention at the claim point.
        // hold_barrier:  every task waits here AFTER claiming/AllBusying and
        //                BEFORE dropping. This guarantees that while any claim
        //                is live, no other task has yet had a chance to release
        //                its claim, so claimed_ids reflects the concurrent claim
        //                state, not sequential reuse.
        let start_barrier = Arc::new(Barrier::new(N));
        let hold_barrier = Arc::new(Barrier::new(N));
        let mut handles = Vec::new();
        for _ in 0..N {
            let pool = Arc::clone(&pool);
            let start = Arc::clone(&start_barrier);
            let hold = Arc::clone(&hold_barrier);
            handles.push(tokio::spawn(async move {
                start.wait().await;
                let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
                match pool.try_claim_render(tx) {
                    ClaimResult::Claimed(c) => {
                        let id = c.entry().id;
                        // Hold the claim until every task is past the claim attempt.
                        hold.wait().await;
                        drop(c);
                        Some(id)
                    }
                    ClaimResult::AllBusy => {
                        hold.wait().await;
                        None
                    }
                    ClaimResult::PoolEmpty => panic!("pool was registered with {M} workers"),
                }
            }));
        }

        let mut claimed_ids = Vec::new();
        let mut all_busy_count = 0usize;
        for h in handles {
            match h.await.unwrap() {
                Some(id) => claimed_ids.push(id),
                None => all_busy_count += 1,
            }
        }

        // (1) Exactly M concurrent claims, N-M AllBusy. The hold barrier
        // ensures no claim was released before every contender attempted,
        // so this measures concurrent state — not sequential reuse.
        assert_eq!(
            claimed_ids.len(),
            M,
            "expected {M} concurrent claims, got {} (ids: {:?})",
            claimed_ids.len(),
            claimed_ids,
        );
        assert_eq!(all_busy_count, N - M);

        // (2) Each successful concurrent claim corresponds to a distinct worker.
        // This is the core anti-TOCTOU assertion: two tasks must not have
        // both observed the same worker as idle.
        let mut sorted = claimed_ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            M,
            "duplicate ids in concurrent claimed set: {:?}",
            claimed_ids,
        );

        // (3) After all tasks finish (claims released after hold barrier),
        // every slot is None and every in_flight is 0.
        for entry in pool.entries.read().iter() {
            assert!(
                entry.slot(0).render_slot().lock().is_none(),
                "worker {} slot still held",
                entry.id,
            );
            assert_eq!(
                entry.in_flight.load(Ordering::Relaxed),
                0,
                "worker {} in_flight not drained",
                entry.id,
            );
        }
    }

    // The core K-slot invariant: ONE worker with K=4 slots must permit exactly
    // 4 CONCURRENT claims (4 distinct slot indices), with further attempts
    // AllBusy — the single-worker analogue of the M-worker race test above.
    // Two-barrier design forces simultaneous claims and holds them all open
    // before any drops, so claimed_slots reflects concurrent state. Must pass
    // under `--release`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn multi_slot_k_concurrent_claims_one_worker() {
        use std::sync::Arc;
        use tokio::sync::Barrier;

        const K: usize = 4; // slots on the single worker
        const N: usize = 8; // concurrent claim attempts

        let pool = Arc::new(WorkerPool::new());
        let id = register_k_for_test(&pool, K);
        assert_eq!(pool.entry(id).unwrap().slot_len(), K);

        // start_barrier: every task waits here before calling try_claim_render —
        //                forces simultaneous contention at the claim point.
        // hold_barrier:  every task waits here AFTER claiming/AllBusying and
        //                BEFORE dropping, so claimed_slots reflects the concurrent
        //                claim state, not sequential reuse.
        let start_barrier = Arc::new(Barrier::new(N));
        let hold_barrier = Arc::new(Barrier::new(N));
        let mut handles = Vec::new();
        for _ in 0..N {
            let pool = Arc::clone(&pool);
            let start = Arc::clone(&start_barrier);
            let hold = Arc::clone(&hold_barrier);
            handles.push(tokio::spawn(async move {
                start.wait().await;
                let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
                match pool.try_claim_render(tx) {
                    ClaimResult::Claimed(c) => {
                        let slot = c.slot();
                        hold.wait().await;
                        drop(c);
                        Some(slot)
                    }
                    ClaimResult::AllBusy => {
                        hold.wait().await;
                        None
                    }
                    ClaimResult::PoolEmpty => panic!("pool has one worker registered"),
                }
            }));
        }

        let mut claimed_slots = Vec::new();
        let mut all_busy_count = 0usize;
        for h in handles {
            match h.await.unwrap() {
                Some(slot) => claimed_slots.push(slot),
                None => all_busy_count += 1,
            }
        }

        // (1) Exactly K concurrent claims, N-K AllBusy.
        assert_eq!(
            claimed_slots.len(),
            K,
            "expected {K} concurrent claims, got {} (slots: {:?})",
            claimed_slots.len(),
            claimed_slots,
        );
        assert_eq!(all_busy_count, N - K);

        // (2) Each successful concurrent claim is a DISTINCT slot index — two
        // tasks must not have both observed the same slot as idle.
        let mut sorted = claimed_slots.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            K,
            "duplicate slot indices in concurrent claimed set: {:?}",
            claimed_slots,
        );

        // (3) After release, every slot is idle and in_flight is 0.
        let entry = pool.entry(id).unwrap();
        for i in 0..K {
            assert!(entry.slot(i).is_idle(), "slot {i} not idle after release");
            assert!(
                entry.slot(i).render_slot().lock().is_none(),
                "slot {i} still held",
            );
        }
        assert_eq!(
            entry.in_flight.load(Ordering::Relaxed),
            0,
            "in_flight not drained",
        );
    }

    fn chunk_kind(c: &RenderChunk) -> &'static str {
        match c {
            RenderChunk::Bytes { .. } => "Bytes",
            RenderChunk::Final { .. } => "Final",
            RenderChunk::BytesAndFinal { .. } => "BytesAndFinal",
        }
    }

    #[tokio::test]
    async fn bytes_and_final_round_trips_through_channel() {
        let (tx, mut rx) = mpsc::channel::<RenderChunk>(1);
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
        let payload = b"hello world".to_vec();

        tx.send(RenderChunk::BytesAndFinal {
            data: payload.clone(),
            ack: ack_tx,
        })
        .await
        .unwrap();

        let received = rx.recv().await.expect("chunk should arrive");
        match received {
            RenderChunk::BytesAndFinal { data, ack } => {
                assert_eq!(data, payload);
                ack.send(()).expect("ack receiver should still be alive");
            }
            other => panic!("expected BytesAndFinal, got {}", chunk_kind(&other)),
        }
        ack_rx.await.expect("ack should resolve");
    }
}
