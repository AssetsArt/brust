//! F529: the socket registry, the topics, the outbound queues and their back-pressure (D5, D7, D8).
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use brust_core::config::WsConfig;
use brust_core::protocol::WsAccept;
use bytes::Bytes;
use parking_lot::{Mutex, RwLock};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use super::{SocketId, WsData, WsSink, socket_id, socket_parts};

/// What the writer task of a socket is told to do, in order.
pub(crate) enum Out {
    /// A frame and the bytes it counts against the outbound limit (0 for pings and pongs).
    Msg(Message, usize),
    /// Send this close frame, then nothing more.
    Close(CloseFrame),
}

/// A socket's limits: the route's Elysia options clamped to `[actions.ws]` (D8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Opts {
    pub(crate) max_payload: usize,
    /// Seconds without a frame from the client before the server closes; 0 = never.
    pub(crate) idle_s: u32,
    /// Seconds between server pings; 0 = none.
    pub(crate) ping_s: u32,
    /// Outbound queue bound, bytes.
    pub(crate) limit: usize,
    pub(crate) close_on_limit: bool,
    pub(crate) publish_to_self: bool,
}

impl Opts {
    /// A route option of 0 (or none) takes the global value; a route may lower a limit, never raise it. A global
    /// timer of 0 is off, so the route's own value stands.
    pub(crate) fn clamp(g: &WsConfig, a: &WsAccept) -> Self {
        let bytes = |r: Option<u32>, g: u32| match r {
            Some(r) if r > 0 => r.min(g),
            _ => g,
        } as usize;
        let secs = |r: Option<u32>, g: u32| match (r, g) {
            (Some(r), 0) => r,
            (Some(r), g) if r > 0 => r.min(g),
            _ => g,
        };
        Self {
            max_payload: bytes(a.max_payload, g.max_payload_bytes),
            idle_s: secs(a.idle_timeout, g.idle_timeout_s),
            ping_s: if a.send_pings.unwrap_or(true) {
                g.ping_interval_s
            } else {
                0
            },
            limit: bytes(a.backpressure_limit, g.backpressure_bytes),
            close_on_limit: a.close_on_backpressure_limit.unwrap_or(false),
            publish_to_self: a.publish_to_self.unwrap_or(false),
        }
    }
}

/// One open socket as the hub sees it.
pub(crate) struct Sock {
    pub(crate) id: SocketId,
    pub(crate) remote: SocketAddr,
    pub(crate) opts: Opts,
    tx: mpsc::UnboundedSender<Out>,
    /// Bytes queued and not yet flushed to the connection.
    queued: AtomicUsize,
    /// A send answered -1 or 0 since the queue last emptied: the writer emits `Drain` when it does.
    pressured: AtomicBool,
    /// No more frames are queued once set (closing, closed or terminated).
    closed: AtomicBool,
    /// Woken when the server starts closing this socket: the reader then waits a bounded time for the peer's close.
    pub(crate) closing: Notify,
    /// Woken by `terminate`: the connection is dropped at once, queued frames and all.
    pub(crate) kill: Notify,
    subs: Mutex<HashSet<Box<str>>>,
}

impl Sock {
    /// D7: `n > 0` queued; `-1` queued past the limit (back-pressure); `0` dropped (closed, or already past the limit;
    /// with `close_on_limit` the socket is then closed with 1013). An accepted empty message answers 0 too.
    fn send(&self, m: Message, n: usize) -> i64 {
        if self.closed.load(Ordering::Acquire) {
            return 0;
        }
        let before = self.queued.load(Ordering::Acquire);
        if before >= self.opts.limit {
            self.pressured.store(true, Ordering::Release);
            if self.opts.close_on_limit {
                self.close(1013, "backpressure limit");
            }
            return 0;
        }
        self.queued.fetch_add(n, Ordering::AcqRel);
        if self.tx.send(Out::Msg(m, n)).is_err() {
            self.queued.fetch_sub(n, Ordering::AcqRel);
            return 0;
        }
        if before + n > self.opts.limit {
            self.pressured.store(true, Ordering::Release);
            -1
        } else {
            n as i64
        }
    }

    /// Queue a ping or pong (not counted against the limit).
    fn control(&self, m: Message) {
        if !self.closed.load(Ordering::Acquire) {
            let _ = self.tx.send(Out::Msg(m, 0));
        }
    }

    /// Start the close handshake with `code`; only the first close (or terminate) counts. A code a close frame may
    /// not carry (1005, 1006, 1015, outside 1000..=4999 or reserved) is sent as 1000.
    pub(crate) fn close(&self, code: u16, reason: &str) -> bool {
        if self.closed.swap(true, Ordering::AcqRel) {
            return false;
        }
        let code = if matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999) {
            code
        } else {
            1000
        };
        let _ = self.tx.send(Out::Close(CloseFrame {
            code: code.into(),
            reason: truncate(reason, 123).to_owned().into(),
        }));
        self.closing.notify_one();
        true
    }

    fn terminate(&self) {
        self.closed.store(true, Ordering::Release);
        self.kill.notify_one();
    }

    /// Stop queueing (the connection ended).
    pub(crate) fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
    }

    /// The writer flushed `n` bytes. True when the queue is now empty after back-pressure: emit `Drain`.
    pub(crate) fn flushed(&self, n: usize) -> bool {
        let left = self.queued.fetch_sub(n, Ordering::AcqRel) - n;
        left == 0 && self.pressured.swap(false, Ordering::AcqRel)
    }
}

/// `s` cut to at most `max` bytes on a char boundary (a close reason fits 123 bytes).
fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    &s[..i]
}

fn message(d: WsData) -> (Message, usize) {
    let n = d.len();
    let m = match d {
        WsData::Text(s) => Message::Text(s.into()),
        WsData::Binary(b) => Message::Binary(b),
    };
    (m, n)
}

/// Why an upgrade is refused before any worker runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Admit {
    /// `[actions.ws] enabled = false`, or no worker side was installed (501).
    Off,
    /// The server is draining (503).
    Draining,
    /// `max_connections` sockets are open (503).
    Full,
}

/// The sockets of one server process, shared with the worker side through [`super::WsSink`] and the methods below.
pub struct WsHub {
    cfg: WsConfig,
    sink: OnceLock<Arc<dyn WsSink>>,
    socks: RwLock<HashMap<SocketId, Arc<Sock>>>,
    topics: RwLock<HashMap<Box<str>, HashSet<SocketId>>>,
    /// Open (and accepted, not yet switched) sockets per worker: the D5 pick and [`WsHub::open_count`].
    counts: Mutex<HashMap<u32, usize>>,
    /// One permit per socket, `max_connections` in all (R8).
    permits: Arc<Semaphore>,
    /// `Some(deadline)` once the server drains (D10).
    drain: watch::Sender<Option<Instant>>,
}

impl WsHub {
    pub(crate) fn new(cfg: WsConfig) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(cfg.max_connections as usize)),
            cfg,
            sink: OnceLock::new(),
            socks: RwLock::default(),
            topics: RwLock::default(),
            counts: Mutex::default(),
            drain: watch::channel(None).0,
        }
    }

    pub(crate) fn config(&self) -> &WsConfig {
        &self.cfg
    }

    /// Install the worker side; the first one wins. False when one was already installed.
    pub(crate) fn set_sink(&self, sink: Arc<dyn WsSink>) -> bool {
        self.sink.set(sink).is_ok()
    }

    pub(crate) fn sink(&self) -> Option<Arc<dyn WsSink>> {
        self.sink.get().cloned()
    }

    /// May one more upgrade go to a worker? The permit is the socket's until it ends.
    pub(crate) fn admit(&self) -> Result<OwnedSemaphorePermit, Admit> {
        if !self.cfg.enabled || self.sink.get().is_none() {
            return Err(Admit::Off);
        }
        if self.drain.borrow().is_some() {
            return Err(Admit::Draining);
        }
        Arc::clone(&self.permits)
            .try_acquire_owned()
            .map_err(|_| Admit::Full)
    }

    /// D10: every socket closes with 1001 and gets until `deadline` for the peer's close.
    pub(crate) fn begin_drain(&self, deadline: Instant) {
        self.drain.send_replace(Some(deadline));
    }

    pub(crate) fn drain_rx(&self) -> watch::Receiver<Option<Instant>> {
        self.drain.subscribe()
    }

    /// Count one socket on `worker` until the guard drops.
    pub(crate) fn count(self: &Arc<Self>, worker: u32) -> WorkerCount {
        *self.counts.lock().entry(worker).or_default() += 1;
        WorkerCount {
            hub: Arc::clone(self),
            worker,
        }
    }

    /// Take a switched socket in. A socket already registered under the same id (a worker reusing an id) is
    /// terminated first.
    pub(crate) fn register(
        &self,
        worker: u32,
        local: u32,
        opts: Opts,
        remote: SocketAddr,
    ) -> (Arc<Sock>, mpsc::UnboundedReceiver<Out>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let id = socket_id(worker, local);
        let s = Arc::new(Sock {
            id,
            remote,
            opts,
            tx,
            queued: AtomicUsize::new(0),
            pressured: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            closing: Notify::new(),
            kill: Notify::new(),
            subs: Mutex::default(),
        });
        // Lock order: never `socks` while taking `topics` (publish holds `topics` then `socks`), so the guard ends here.
        let old = self.socks.write().insert(id, Arc::clone(&s));
        if let Some(old) = old {
            old.terminate();
            self.drop_topics(&old);
        }
        (s, rx)
    }

    /// The socket ended: out of the registry and every topic (only if `s` is still the registered one).
    pub(crate) fn unregister(&self, s: &Arc<Sock>) {
        s.mark_closed();
        {
            let mut socks = self.socks.write();
            match socks.get(&s.id) {
                Some(cur) if Arc::ptr_eq(cur, s) => {
                    socks.remove(&s.id);
                }
                _ => {}
            }
        }
        self.drop_topics(s);
    }

    fn drop_topics(&self, s: &Sock) {
        let subs = std::mem::take(&mut *s.subs.lock());
        if subs.is_empty() {
            return;
        }
        let mut topics = self.topics.write();
        for t in subs {
            if let Some(set) = topics.get_mut(&t) {
                set.remove(&s.id);
                if set.is_empty() {
                    topics.remove(&t);
                }
            }
        }
    }

    /// The worker went away (dead worker, dev reload): its sockets close with 1012 "service restart".
    pub(crate) fn close_worker(&self, worker: u32) {
        let socks: Vec<Arc<Sock>> = self
            .socks
            .read()
            .values()
            .filter(|s| socket_parts(s.id).0 == worker)
            .cloned()
            .collect();
        for s in socks {
            s.close(1012, "service restart");
        }
    }

    fn get(&self, id: SocketId) -> Option<Arc<Sock>> {
        self.socks.read().get(&id).cloned()
    }

    // ----- the worker side's calls (§2b) -----

    /// D7: `n > 0` bytes queued, `-1` queued past the outbound limit, `0` dropped (unknown or closed socket, or past
    /// the limit already).
    pub fn send(&self, id: SocketId, d: WsData) -> i64 {
        let Some(s) = self.get(id) else { return 0 };
        let (m, n) = message(d);
        s.send(m, n)
    }

    /// Start the close handshake (the first close or terminate wins).
    pub fn close(&self, id: SocketId, code: u16, reason: &str) {
        if let Some(s) = self.get(id) {
            s.close(code, reason);
        }
    }

    /// Drop the connection without a close frame.
    pub fn terminate(&self, id: SocketId) {
        if let Some(s) = self.get(id) {
            s.terminate();
        }
    }

    /// True when the socket is open (and now subscribed to `topic`).
    pub fn subscribe(&self, id: SocketId, topic: &str) -> bool {
        let Some(s) = self.get(id) else { return false };
        if s.closed.load(Ordering::Acquire) {
            return false;
        }
        let mut topics = self.topics.write();
        s.subs.lock().insert(topic.into());
        topics.entry(topic.into()).or_default().insert(id);
        true
    }

    /// True when the socket was subscribed to `topic`.
    pub fn unsubscribe(&self, id: SocketId, topic: &str) -> bool {
        let Some(s) = self.get(id) else { return false };
        let mut topics = self.topics.write();
        if !s.subs.lock().remove(topic) {
            return false;
        }
        if let Some(set) = topics.get_mut(topic) {
            set.remove(&id);
            if set.is_empty() {
                topics.remove(topic);
            }
        }
        true
    }

    pub fn is_subscribed(&self, id: SocketId, topic: &str) -> bool {
        self.get(id).is_some_and(|s| s.subs.lock().contains(topic))
    }

    pub fn subscriptions(&self, id: SocketId) -> Vec<String> {
        let mut v: Vec<String> = self
            .get(id)
            .map(|s| s.subs.lock().iter().map(|t| t.to_string()).collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    /// Queue `d` on every socket subscribed to `topic`, whatever its worker. `except` (the publishing socket) is
    /// skipped unless its route set `publishToSelf`. The bytes queued in all (a socket past its limit is skipped);
    /// 0 when nobody got it.
    pub fn publish(&self, topic: &str, d: WsData, except: Option<SocketId>) -> i64 {
        let targets: Vec<Arc<Sock>> = {
            let topics = self.topics.read();
            let Some(ids) = topics.get(topic) else {
                return 0;
            };
            let socks = self.socks.read();
            let keep_self = except
                .and_then(|e| socks.get(&e))
                .is_some_and(|s| s.opts.publish_to_self);
            ids.iter()
                .filter(|&&id| keep_self || Some(id) != except)
                .filter_map(|id| socks.get(id).cloned())
                .collect()
        };
        let (m, n) = message(d);
        let mut total = 0i64;
        for s in targets {
            match s.send(m.clone(), n) {
                -1 => total += n as i64,
                r => total += r,
            }
        }
        total
    }

    pub fn ping(&self, id: SocketId, d: Bytes) {
        if let Some(s) = self.get(id) {
            s.control(Message::Ping(d));
        }
    }

    pub fn pong(&self, id: SocketId, d: Bytes) {
        if let Some(s) = self.get(id) {
            s.control(Message::Pong(d));
        }
    }

    pub fn remote_addr(&self, id: SocketId) -> Option<SocketAddr> {
        self.get(id).map(|s| s.remote)
    }

    /// Sockets open on `worker`, counting accepted upgrades that have not switched yet (D5).
    pub fn open_count(&self, worker: u32) -> usize {
        self.counts.lock().get(&worker).copied().unwrap_or(0)
    }

    /// Every open socket.
    pub fn open_total(&self) -> usize {
        self.socks.read().len()
    }
}

/// One socket counted on its worker ([`WsHub::open_count`]) for as long as this lives.
pub(crate) struct WorkerCount {
    hub: Arc<WsHub>,
    worker: u32,
}

impl WorkerCount {
    pub(crate) fn worker(&self) -> u32 {
        self.worker
    }
}

impl Drop for WorkerCount {
    fn drop(&mut self) {
        let mut c = self.hub.counts.lock();
        if let Some(n) = c.get_mut(&self.worker) {
            *n -= 1;
            if *n == 0 {
                c.remove(&self.worker);
            }
        }
    }
}

/// The D5 pick of one upgrade request: the pool's claim fills it ([`super::WS_PICK`]).
#[derive(Default)]
pub(crate) struct WsPick(Mutex<Option<WorkerCount>>);

impl WsPick {
    pub(crate) fn set(&self, c: WorkerCount) {
        *self.0.lock() = Some(c);
    }

    pub(crate) fn take(&self) -> Option<WorkerCount> {
        self.0.lock().take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accept(f: impl FnOnce(&mut WsAccept)) -> WsAccept {
        let mut a = WsAccept {
            id: 1,
            max_payload: None,
            idle_timeout: None,
            backpressure_limit: None,
            close_on_backpressure_limit: None,
            publish_to_self: None,
            send_pings: None,
        };
        f(&mut a);
        a
    }

    #[test]
    fn route_options_are_clamped_to_the_global_maxima() {
        let g = WsConfig::default();
        let d = Opts::clamp(&g, &accept(|_| {}));
        assert_eq!(
            d,
            Opts {
                max_payload: 1_048_576,
                idle_s: 120,
                ping_s: 30,
                limit: 1_048_576,
                close_on_limit: false,
                publish_to_self: false
            }
        );
        let o = Opts::clamp(
            &g,
            &accept(|a| {
                a.max_payload = Some(64 << 20);
                a.idle_timeout = Some(10_000);
                a.backpressure_limit = Some(4096);
                a.close_on_backpressure_limit = Some(true);
                a.publish_to_self = Some(true);
                a.send_pings = Some(false);
            }),
        );
        assert_eq!(
            (
                o.max_payload,
                o.idle_s,
                o.ping_s,
                o.limit,
                o.close_on_limit,
                o.publish_to_self
            ),
            (1_048_576, 120, 0, 4096, true, true)
        );
        // 0 from the route = the global value; a global timer of 0 is off, so the route's value stands
        let o = Opts::clamp(
            &g,
            &accept(|a| {
                a.max_payload = Some(0);
                a.idle_timeout = Some(0);
            }),
        );
        assert_eq!((o.max_payload, o.idle_s), (1_048_576, 120));
        let off = WsConfig {
            idle_timeout_s: 0,
            ..g
        };
        assert_eq!(
            Opts::clamp(&off, &accept(|a| a.idle_timeout = Some(7))).idle_s,
            7
        );
        assert_eq!(Opts::clamp(&off, &accept(|_| {})).idle_s, 0);
    }

    fn closed_with(rx: &mut mpsc::UnboundedReceiver<Out>) -> Option<u16> {
        match rx.try_recv() {
            Ok(Out::Close(f)) => Some(u16::from(f.code)),
            _ => None,
        }
    }

    #[test]
    fn a_worker_leaving_the_pool_closes_its_sockets_with_1012() {
        let pool = crate::pool::WorkerPool::new();
        let hub = Arc::new(WsHub::new(WsConfig::default()));
        pool.set_ws_hub(Arc::clone(&hub));
        let w0 = pool.register(Box::new(crate::dispatch::MockDispatch::new()));
        let w1 = pool.register(Box::new(crate::dispatch::MockDispatch::new()));
        let opts = Opts::clamp(&WsConfig::default(), &accept(|_| {}));
        let addr: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let (_a, mut ra) = hub.register(w0, 1, opts, addr);
        let (_b, mut rb) = hub.register(w1, 1, opts, addr);
        pool.remove(w0);
        assert_eq!(closed_with(&mut ra), Some(1012));
        assert_eq!(
            closed_with(&mut rb),
            None,
            "the other worker's socket stays"
        );
        let (_c, mut rc) = hub.register(w1, 2, opts, addr);
        pool.clear();
        assert_eq!(closed_with(&mut rb), Some(1012));
        assert_eq!(closed_with(&mut rc), Some(1012));
    }

    #[test]
    fn close_codes_a_frame_may_not_carry_become_1000_and_only_the_first_close_counts() {
        let hub = WsHub::new(WsConfig::default());
        let opts = Opts::clamp(&WsConfig::default(), &accept(|_| {}));
        let addr: SocketAddr = "127.0.0.1:1".parse().unwrap();
        for (code, sent) in [
            (1006, 1000),
            (1005, 1000),
            (999, 1000),
            (2999, 1000),
            (5000, 1000),
            (1011, 1011),
            (4999, 4999),
        ] {
            let (s, mut rx) = hub.register(0, code.into(), opts, addr);
            assert!(s.close(code, "x"));
            assert!(!s.close(1000, "again"));
            assert_eq!(closed_with(&mut rx), Some(sent), "{code}");
            assert_eq!(hub.send(s.id, WsData::Text("late".into())), 0);
        }
    }

    #[test]
    fn a_close_reason_is_cut_on_a_char_boundary() {
        assert_eq!(truncate("abc", 123), "abc");
        let s = "é".repeat(100);
        let t = truncate(&s, 123);
        assert_eq!(t.len(), 122);
    }
}
