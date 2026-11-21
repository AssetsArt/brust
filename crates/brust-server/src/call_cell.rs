//! F604: the completion cell of one (worker, slot).
//!
//! A worker call no longer returns a Promise to Rust. The server ARMS the slot's cell (a new
//! generation), sends the call, and awaits the cell; the worker's JS wrapper completes it with ONE
//! native call, `callDone(worker, slot, gen, len)`, after the response bytes are in the slot. The
//! protocol follows Nylon Ring's host (`send_result` on a session id; an unknown or finished id is
//! refused), with one reusable cell per (worker, slot) instead of a map of pending sessions.
//!
//! The state and the generation share ONE atomic word (`gen << 3 | state`), so every transition is
//! a single compare-and-swap on the exact (generation, state) pair: a completion for another
//! generation can never match, even if it raced a re-arm.
//!
//! States:
//! - `IDLE`: no call. `arm` moves it to `WAITING` with the next generation.
//! - `WAITING`: the call is in the worker. `done` -> `COMPLETING` -> `READY`; the claim dropping
//!   before that (deadline, client gone, panic) -> `ABANDONED`.
//! - `COMPLETING`: `done` won the CAS and is storing the length (a few instructions).
//! - `READY`: the length is published; the waiter reads it. The claim's drop -> `IDLE`.
//! - `ABANDONED`: the waiter is gone but the worker may still write the slot, so the SLOT STAYS
//!   CLAIMED; the late `done` (or the worker's exit) releases it.
//! - `CLOSED`: the worker exited, or the generation space is used up. Terminal: `arm` refuses.
//!
//! At most ONE generation per cell is ever outstanding (a cell is re-armed only from `IDLE`, which
//! only the claim holder reaches after the worker answered), so a stale completion is impossible by
//! construction; the generation is the second lock. It is a u64 that only grows and stays at or
//! below 2^53 - 1 (it crosses to JS as an exact number); on reaching the cap the cell closes
//! instead of wrapping.

#[cfg(brust_loom)]
use loom::future::AtomicWaker;
#[cfg(brust_loom)]
use loom::sync::atomic::{AtomicU32, AtomicU64, Ordering};

#[cfg(not(brust_loom))]
use futures_util::task::AtomicWaker;
#[cfg(not(brust_loom))]
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use std::task::{Context, Poll};

const IDLE: u64 = 0;
const WAITING: u64 = 1;
const COMPLETING: u64 = 2;
const READY: u64 = 3;
const ABANDONED: u64 = 4;
const CLOSED: u64 = 5;
const STATE_BITS: u32 = 3;
const STATE_MASK: u64 = (1 << STATE_BITS) - 1;

/// The largest generation: the biggest integer a JS number holds exactly.
pub const MAX_GEN: u64 = (1 << 53) - 1;

/// `len` value of a handler that failed without leaving a message in the slot.
pub const FAILED: u32 = u32::MAX;
/// `len` bit of a handler that failed and wrote its message (UTF-8, `len & !FAILED_WITH_TEXT`
/// bytes) into the slot.
pub const FAILED_WITH_TEXT: u32 = 1 << 31;

fn word(generation: u64, state: u64) -> u64 {
    (generation << STATE_BITS) | state
}

fn split(w: u64) -> (u64, u64) {
    (w >> STATE_BITS, w & STATE_MASK)
}

/// Why [`CallCell::arm`] refused.
#[derive(Debug, PartialEq, Eq)]
pub enum ArmError {
    /// The worker exited: its cells are closed.
    Closed,
    /// The generation reached [`MAX_GEN`]; the cell is closed now.
    Exhausted,
    /// The cell is not idle (a bug: the slot is claimed exclusively before arming).
    Busy,
}

/// What a [`CallCell::done`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Done {
    /// The waiting call got its length.
    Completed,
    /// The call had been abandoned: the caller must now release the slot.
    Release,
    /// Not the armed generation, already completed, or closed: nothing changed.
    Ignored,
}

/// What a waiting call sees.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The worker completed the call with this length.
    Len(u32),
    /// The worker exited (or the cell closed) before completing it.
    Closed,
}

/// One (worker, slot)'s completion cell. Created with the pool, reused for every call.
pub struct CallCell {
    word: AtomicU64,
    len: AtomicU32,
    waker: AtomicWaker,
}

impl Default for CallCell {
    fn default() -> Self {
        Self::new()
    }
}

impl CallCell {
    pub fn new() -> Self {
        Self::starting_at(0)
    }

    /// A cell whose next generation is `last + 1` (tests of the cap).
    pub fn starting_at(last: u64) -> Self {
        Self {
            word: AtomicU64::new(word(last, IDLE)),
            len: AtomicU32::new(0),
            waker: AtomicWaker::new(),
        }
    }

    /// Start a call: `IDLE` -> `WAITING` with the next generation, returned.
    pub fn arm(&self) -> Result<u64, ArmError> {
        let cur = self.word.load(Ordering::Acquire);
        let (g, s) = split(cur);
        match s {
            CLOSED => return Err(ArmError::Closed),
            IDLE => {}
            _ => return Err(ArmError::Busy),
        }
        if g >= MAX_GEN {
            let _ = self.word.compare_exchange(
                cur,
                word(g, CLOSED),
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            return Err(ArmError::Exhausted);
        }
        let next = g + 1;
        match self.word.compare_exchange(
            cur,
            word(next, WAITING),
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => Ok(next),
            Err(w) if split(w).1 == CLOSED => Err(ArmError::Closed),
            Err(_) => Err(ArmError::Busy),
        }
    }

    /// The call of `generation` was never sent (the enqueue failed): back to `IDLE`.
    pub fn disarm(&self, generation: u64) {
        let _ = self.word.compare_exchange(
            word(generation, WAITING),
            word(generation, IDLE),
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    /// The worker's completion of `generation` with `len`. Called on the worker's JS thread after
    /// the response bytes are in the slot; the `READY` store (Release) orders them before the
    /// waiter's read (Acquire).
    pub fn done(&self, generation: u64, len: u32) -> Done {
        if generation == 0 || generation > MAX_GEN {
            return Done::Ignored;
        }
        if self
            .word
            .compare_exchange(
                word(generation, WAITING),
                word(generation, COMPLETING),
                Ordering::Acquire,
                Ordering::Relaxed,
            )
            .is_ok()
        {
            self.len.store(len, Ordering::Relaxed);
            self.word.store(word(generation, READY), Ordering::Release);
            self.waker.wake();
            return Done::Completed;
        }
        if self
            .word
            .compare_exchange(
                word(generation, ABANDONED),
                word(generation, IDLE),
                Ordering::AcqRel,
                Ordering::Relaxed,
            )
            .is_ok()
        {
            return Done::Release;
        }
        Done::Ignored
    }

    /// Poll the call of `generation`.
    pub fn poll_outcome(&self, generation: u64, cx: &mut Context<'_>) -> Poll<Outcome> {
        if let Some(o) = self.outcome(generation) {
            return Poll::Ready(o);
        }
        #[cfg(not(brust_loom))]
        self.waker.register(cx.waker());
        #[cfg(brust_loom)]
        self.waker.register_by_ref(cx.waker());
        match self.outcome(generation) {
            Some(o) => Poll::Ready(o),
            None => Poll::Pending,
        }
    }

    fn outcome(&self, generation: u64) -> Option<Outcome> {
        let (g, s) = split(self.word.load(Ordering::Acquire));
        match s {
            READY if g == generation => Some(Outcome::Len(self.len.load(Ordering::Relaxed))),
            CLOSED => Some(Outcome::Closed),
            // Not ours any more (cannot happen while the waiter holds the claim).
            _ if g != generation => Some(Outcome::Closed),
            _ => None,
        }
    }

    /// The claim of this slot is being dropped. `true` = release the slot now (no call, or the
    /// call completed, or the cell is closed); `false` = the call is still in the worker: the cell
    /// is `ABANDONED` and keeps the slot until the late `done` or the worker's exit.
    pub fn on_claim_drop(&self) -> bool {
        loop {
            let cur = self.word.load(Ordering::Acquire);
            let (g, s) = split(cur);
            let next = match s {
                IDLE | CLOSED => return true,
                READY => word(g, IDLE),
                WAITING => word(g, ABANDONED),
                COMPLETING => {
                    // `done` is between its two stores: wait for READY.
                    spin();
                    continue;
                }
                _ => return false,
            };
            if self
                .word
                .compare_exchange(cur, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return s == READY;
            }
        }
    }

    /// The worker exited: the cell closes for good. A waiting call wakes and sees
    /// [`Outcome::Closed`]; later `done`s are ignored. Returns `true` when the cell was
    /// `ABANDONED` (its slot was still held for the worker).
    pub fn close(&self) -> bool {
        loop {
            let cur = self.word.load(Ordering::Acquire);
            let (g, s) = split(cur);
            match s {
                CLOSED => return false,
                // A completed call keeps its result; the claim's drop takes it to IDLE and the next
                // `arm` reaches a worker that is gone (the enqueue fails).
                READY => return false,
                COMPLETING => {
                    spin();
                    continue;
                }
                _ => {}
            }
            if self
                .word
                .compare_exchange(cur, word(g, CLOSED), Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                if s == WAITING {
                    self.waker.wake();
                }
                return s == ABANDONED;
            }
        }
    }

    #[cfg(test)]
    fn state(&self) -> (u64, u64) {
        split(self.word.load(Ordering::Acquire))
    }
}

#[cfg(brust_loom)]
fn spin() {
    loom::thread::yield_now();
}

#[cfg(not(brust_loom))]
fn spin() {
    std::hint::spin_loop();
}

#[cfg(all(test, not(brust_loom)))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::task::{Wake, Waker};

    struct Count(AtomicUsize);
    impl Wake for Count {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn waker() -> (Arc<Count>, Waker) {
        let c = Arc::new(Count(AtomicUsize::new(0)));
        (Arc::clone(&c), Waker::from(c))
    }

    #[test]
    fn a_call_completes_and_its_claim_drop_releases() {
        let c = CallCell::new();
        let g = c.arm().unwrap();
        assert_eq!(g, 1);
        let (woken, w) = waker();
        let mut cx = Context::from_waker(&w);
        assert!(c.poll_outcome(g, &mut cx).is_pending());
        assert_eq!(c.done(g, 42), Done::Completed);
        assert_eq!(woken.0.load(Ordering::SeqCst), 1);
        assert_eq!(c.poll_outcome(g, &mut cx), Poll::Ready(Outcome::Len(42)));
        assert!(c.on_claim_drop());
        assert_eq!(c.state(), (1, IDLE));
    }

    #[test]
    fn a_stale_generation_is_ignored() {
        let c = CallCell::new();
        let g = c.arm().unwrap();
        assert_eq!(c.done(g + 1, 7), Done::Ignored);
        assert_eq!(c.done(g - 1, 7), Done::Ignored);
        assert_eq!(c.state(), (g, WAITING));
    }

    #[test]
    fn a_done_for_an_unarmed_cell_is_ignored() {
        let c = CallCell::new();
        assert_eq!(c.done(0, 7), Done::Ignored);
        assert_eq!(c.done(1, 7), Done::Ignored);
        assert_eq!(c.state(), (0, IDLE));
    }

    #[test]
    fn a_second_done_is_ignored() {
        let c = CallCell::new();
        let g = c.arm().unwrap();
        assert_eq!(c.done(g, 1), Done::Completed);
        assert_eq!(c.done(g, 2), Done::Ignored);
        let (_, w) = waker();
        assert_eq!(
            c.poll_outcome(g, &mut Context::from_waker(&w)),
            Poll::Ready(Outcome::Len(1))
        );
    }

    #[test]
    fn two_calls_in_sequence_each_get_their_own_result() {
        let c = CallCell::new();
        let (_, w) = waker();
        let mut cx = Context::from_waker(&w);
        let a = c.arm().unwrap();
        assert_eq!(c.done(a, 10), Done::Completed);
        assert_eq!(c.poll_outcome(a, &mut cx), Poll::Ready(Outcome::Len(10)));
        assert!(c.on_claim_drop());
        let b = c.arm().unwrap();
        assert_eq!(b, a + 1);
        assert_eq!(
            c.done(a, 99),
            Done::Ignored,
            "the first call's id does not complete the second"
        );
        assert!(c.poll_outcome(b, &mut cx).is_pending());
        assert_eq!(c.done(b, 20), Done::Completed);
        assert_eq!(c.poll_outcome(b, &mut cx), Poll::Ready(Outcome::Len(20)));
    }

    #[test]
    fn a_dropped_call_keeps_the_slot_until_its_late_done() {
        let c = CallCell::new();
        let g = c.arm().unwrap();
        assert!(
            !c.on_claim_drop(),
            "the worker may still write: keep the slot"
        );
        assert_eq!(c.state(), (g, ABANDONED));
        assert_eq!(c.arm(), Err(ArmError::Busy));
        assert_eq!(c.done(g, 5), Done::Release);
        assert_eq!(c.state(), (g, IDLE));
        let next = c.arm().unwrap();
        assert_eq!(next, g + 1);
        let (_, w) = waker();
        let mut cx = Context::from_waker(&w);
        assert!(
            c.poll_outcome(next, &mut cx).is_pending(),
            "the late done did not complete the next call"
        );
        assert_eq!(c.done(next, 6), Done::Completed);
        assert_eq!(c.poll_outcome(next, &mut cx), Poll::Ready(Outcome::Len(6)));
    }

    #[test]
    fn close_wakes_a_waiting_call_and_refuses_later_arms_and_dones() {
        let c = CallCell::new();
        let g = c.arm().unwrap();
        let (woken, w) = waker();
        let mut cx = Context::from_waker(&w);
        assert!(c.poll_outcome(g, &mut cx).is_pending());
        assert!(!c.close());
        assert_eq!(woken.0.load(Ordering::SeqCst), 1);
        assert_eq!(c.poll_outcome(g, &mut cx), Poll::Ready(Outcome::Closed));
        assert_eq!(c.done(g, 3), Done::Ignored);
        assert!(c.on_claim_drop(), "a closed cell releases its claim");
        assert_eq!(c.arm(), Err(ArmError::Closed));
    }

    #[test]
    fn close_of_an_abandoned_cell_reports_it() {
        let c = CallCell::new();
        let g = c.arm().unwrap();
        assert!(!c.on_claim_drop());
        assert!(c.close());
        assert_eq!(c.done(g, 1), Done::Ignored);
    }

    #[test]
    fn disarm_returns_an_unsent_call_to_idle() {
        let c = CallCell::new();
        let g = c.arm().unwrap();
        c.disarm(g);
        assert_eq!(c.state(), (g, IDLE));
        assert_eq!(c.arm().unwrap(), g + 1);
    }

    #[test]
    fn the_generation_closes_at_the_cap_instead_of_wrapping() {
        let c = CallCell::starting_at(MAX_GEN - 1);
        let g = c.arm().unwrap();
        assert_eq!(g, MAX_GEN);
        assert_eq!(c.done(g, 1), Done::Completed);
        assert!(c.on_claim_drop());
        assert_eq!(c.arm(), Err(ArmError::Exhausted));
        assert_eq!(c.arm(), Err(ArmError::Closed));
        assert_eq!(c.state(), (MAX_GEN, CLOSED));
        assert_eq!(c.done(MAX_GEN + 1, 1), Done::Ignored);
    }
}

#[cfg(all(test, brust_loom))]
mod loom_tests {
    //! `RUSTFLAGS="--cfg brust_loom" cargo test -p brust-server --release --lib call_cell::loom_tests`
    use super::*;
    use loom::sync::Arc;
    use loom::thread;

    /// done vs the claim's drop: exactly one side releases the slot, and a completed call is
    /// either read (READY) or released by the drop.
    #[test]
    fn done_vs_drop_releases_the_slot_exactly_once() {
        loom::model(|| {
            let c = Arc::new(CallCell::new());
            let g = c.arm().unwrap();
            let c2 = Arc::clone(&c);
            let worker = thread::spawn(move || c2.done(g, 9));
            let released_by_drop = c.on_claim_drop();
            let d = worker.join().unwrap();
            let released_by_done = d == Done::Release;
            assert!(
                released_by_drop ^ released_by_done,
                "drop {released_by_drop}, done {d:?}"
            );
            assert_eq!(c.state(), (g, IDLE));
        });
    }

    /// A late done of the previous generation racing the re-arm and the next done: the next call
    /// gets ITS length, never the stale one.
    #[test]
    fn a_stale_done_never_completes_the_rearmed_call() {
        loom::model(|| {
            let c = Arc::new(CallCell::new());
            let a = c.arm().unwrap();
            assert_eq!(c.done(a, 1), Done::Completed);
            let c2 = Arc::clone(&c);
            let stale = thread::spawn(move || c2.done(a, 666));
            assert!(c.on_claim_drop());
            let b = c.arm().unwrap();
            let c3 = Arc::clone(&c);
            let fresh = thread::spawn(move || c3.done(b, 2));
            assert_eq!(stale.join().unwrap(), Done::Ignored);
            assert_eq!(fresh.join().unwrap(), Done::Completed);
            assert_eq!(c.outcome(b), Some(Outcome::Len(2)));
        });
    }

    /// Two dones of one generation: exactly one completes.
    #[test]
    fn done_twice_completes_once() {
        loom::model(|| {
            let c = Arc::new(CallCell::new());
            let g = c.arm().unwrap();
            let (c1, c2) = (Arc::clone(&c), Arc::clone(&c));
            let x = thread::spawn(move || c1.done(g, 1));
            let y = thread::spawn(move || c2.done(g, 2));
            let r = [x.join().unwrap(), y.join().unwrap()];
            assert_eq!(r.iter().filter(|d| **d == Done::Completed).count(), 1);
            let Some(Outcome::Len(n)) = c.outcome(g) else {
                panic!("not ready")
            };
            assert!(n == 1 || n == 2);
        });
    }

    /// The worker's exit vs its done: the waiter sees either the length or Closed, and a done
    /// after the close changes nothing.
    #[test]
    fn exit_vs_done() {
        loom::model(|| {
            let c = Arc::new(CallCell::new());
            let g = c.arm().unwrap();
            let c2 = Arc::clone(&c);
            let worker = thread::spawn(move || c2.done(g, 4));
            c.close();
            let d = worker.join().unwrap();
            match c.outcome(g) {
                Some(Outcome::Len(4)) => assert_eq!(d, Done::Completed),
                Some(Outcome::Closed) => assert_eq!(d, Done::Ignored),
                other => panic!("{other:?}"),
            }
        });
    }
}
