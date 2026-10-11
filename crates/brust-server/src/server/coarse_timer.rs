//! M3-P P7 (ruling R2): a coarse, sharded timer for hyper's `header_read_timeout`.
//!
//! hyper arms the header-read sleep for every request on a keep-alive connection and drops it
//! once the head parsed. On `TokioTimer` that is a register and a clear on tokio's timer wheel,
//! each under one process-global lock (5,113 blocked samples on probe I, `bench/ATTRIBUTION.md`).
//! Here a pending sleep registers in one of [`SHARDS`] shard-local slabs, picked per thread, and a
//! single ticker task wakes the expired ones every `tick`: a sleep fires within one tick after its
//! deadline (100 ms in production, R2), never before it.
//!
//! An entry is owned by its [`CoarseSleep`]: only the sleep removes it (when it completes, is reset
//! or dropped). The ticker only TAKES the waker of an expired entry, so a slab index is never
//! freed while its sleep may still refer to it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// Shard count. Writers on different threads take different locks.
pub const SHARDS: usize = 64;
/// The production tick (R2).
pub const TICK: Duration = Duration::from_millis(100);

struct Entry {
    deadline: Instant,
    /// Taken by the ticker when it wakes the entry; refreshed by a later pending poll.
    waker: Option<Waker>,
}

#[derive(Default)]
struct Shard {
    entries: Vec<Option<Entry>>,
    free: Vec<usize>,
    live: usize,
}

struct Inner {
    shards: Box<[Mutex<Shard>]>,
    tick: Duration,
}

/// A [`hyper::rt::Timer`] whose sleeps are woken by one ticker task. Cheap to clone (one `Arc`).
#[derive(Clone)]
pub struct CoarseTimer(Arc<Inner>);

static NEXT_SHARD: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    /// This thread's shard, assigned round-robin at first use.
    static MY_SHARD: usize = NEXT_SHARD.fetch_add(1, Ordering::Relaxed) % SHARDS;
}

impl CoarseTimer {
    pub fn new(tick: Duration) -> Self {
        let shards = (0..SHARDS).map(|_| Mutex::new(Shard::default())).collect();
        CoarseTimer(Arc::new(Inner {
            shards,
            tick: tick.max(Duration::from_millis(1)),
        }))
    }

    /// Spawn the ticker on the current tokio runtime. It ends when every handle of this timer is
    /// gone, or when the returned handle is aborted (the server does that after its drain).
    pub fn spawn_ticker(&self) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(&self.0);
        let tick = self.0.tick;
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(tick);
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                iv.tick().await;
                let Some(inner) = weak.upgrade() else { return };
                inner.fire(Instant::now());
            }
        })
    }

    /// Entries currently registered (pending sleeps), over all shards.
    pub fn registered(&self) -> usize {
        self.0.shards.iter().map(|s| s.lock().live).sum()
    }

    fn sleep_at(&self, deadline: Instant) -> CoarseSleep {
        CoarseSleep {
            inner: Arc::clone(&self.0),
            deadline,
            key: None,
            waker: None,
        }
    }
}

impl Inner {
    /// Wake every registered entry whose deadline has passed. A shard's lock is never held while
    /// a waker runs.
    fn fire(&self, now: Instant) {
        let mut due: Vec<Waker> = Vec::new();
        for shard in self.shards.iter() {
            {
                let mut g = shard.lock();
                if g.live == 0 {
                    continue;
                }
                for e in g.entries.iter_mut().flatten() {
                    if e.deadline <= now
                        && let Some(w) = e.waker.take()
                    {
                        due.push(w);
                    }
                }
            }
            for w in due.drain(..) {
                w.wake();
            }
        }
    }
}

impl std::fmt::Debug for CoarseTimer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoarseTimer")
            .field("tick", &self.0.tick)
            .finish_non_exhaustive()
    }
}

impl hyper::rt::Timer for CoarseTimer {
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn hyper::rt::Sleep>> {
        Box::pin(self.sleep_at(Instant::now() + duration))
    }

    fn sleep_until(&self, deadline: Instant) -> Pin<Box<dyn hyper::rt::Sleep>> {
        Box::pin(self.sleep_at(deadline))
    }

    fn reset(&self, sleep: &mut Pin<Box<dyn hyper::rt::Sleep>>, new_deadline: Instant) {
        match sleep.as_mut().downcast_mut_pin::<CoarseSleep>() {
            Some(s) => s.get_mut().reset(new_deadline),
            None => *sleep = self.sleep_until(new_deadline),
        }
    }
}

/// One sleep of a [`CoarseTimer`]: Ready iff `Instant::now() >= deadline`. A pending poll
/// registers it (or refreshes its waker) in exactly one shard; completion, reset and drop
/// unregister it.
pub struct CoarseSleep {
    inner: Arc<Inner>,
    deadline: Instant,
    /// (shard, slab index) while registered.
    key: Option<(usize, usize)>,
    /// The waker last stored in the entry, to skip the lock when it is unchanged.
    waker: Option<Waker>,
}

impl CoarseSleep {
    fn reset(&mut self, deadline: Instant) {
        self.unregister();
        self.deadline = deadline;
    }

    fn unregister(&mut self) {
        if let Some((s, i)) = self.key.take() {
            let stale = {
                let mut g = self.inner.shards[s].lock();
                let e = g.entries[i].take();
                g.free.push(i);
                g.live -= 1;
                e
            };
            drop(stale);
        }
        self.waker = None;
    }
}

impl Future for CoarseSleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        if Instant::now() >= this.deadline {
            this.unregister();
            return Poll::Ready(());
        }
        match this.key {
            None => {
                let s = MY_SHARD.with(|s| *s);
                let entry = Entry {
                    deadline: this.deadline,
                    waker: Some(cx.waker().clone()),
                };
                let i = {
                    let mut g = this.inner.shards[s].lock();
                    g.live += 1;
                    match g.free.pop() {
                        Some(i) => {
                            g.entries[i] = Some(entry);
                            i
                        }
                        None => {
                            g.entries.push(Some(entry));
                            g.entries.len() - 1
                        }
                    }
                };
                this.key = Some((s, i));
                this.waker = Some(cx.waker().clone());
            }
            Some((s, i)) => {
                if !this.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
                    let old = {
                        let mut g = this.inner.shards[s].lock();
                        g.entries[i]
                            .as_mut()
                            .and_then(|e| e.waker.replace(cx.waker().clone()))
                    };
                    drop(old);
                    this.waker = Some(cx.waker().clone());
                }
            }
        }
        Poll::Pending
    }
}

impl hyper::rt::Sleep for CoarseSleep {}

impl Drop for CoarseSleep {
    fn drop(&mut self) {
        self.unregister();
    }
}
