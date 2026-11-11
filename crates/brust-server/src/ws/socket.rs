//! F529: one socket's life after the `101`: a reader (frames → events, idle timeout, pings, drain), a writer (the
//! outbound queue → frames) and an events lane (events → the pinned worker, in order, at most [`CREDITS`] unsettled).
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::stream::{FuturesUnordered, SplitSink};
use futures_util::{SinkExt, StreamExt};
use hyper::upgrade::{OnUpgrade, Upgraded};
use hyper_util::rt::TokioIo;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::error::{CapacityError, Error as WsError, ProtocolError};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tracing::debug;

use super::hub::{Opts, Out, Sock, WorkerCount, WsHub};
use super::{WsData, WsEvent, WsSink};

/// D6: events of one socket the worker may have unsettled; the reader stops reading (TCP back-pressure) past this.
pub(crate) const CREDITS: usize = 8;

/// How long a close the server started waits for the peer's close frame (the drain uses its own deadline).
const CLOSE_WAIT: Duration = Duration::from_secs(5);

type Ws = WebSocketStream<TokioIo<Upgraded>>;
type Lane = mpsc::UnboundedSender<(WsEvent, Option<OwnedSemaphorePermit>)>;

/// An accepted upgrade, before the switch.
pub(crate) struct Accepted {
    pub(crate) local: u32,
    pub(crate) opts: Opts,
    pub(crate) remote: SocketAddr,
    /// The `max_connections` permit, the worker's socket count and the connection's drain barrier: all held to the end.
    pub(crate) permit: OwnedSemaphorePermit,
    pub(crate) count: WorkerCount,
    pub(crate) token: Option<mpsc::Sender<()>>,
}

/// Run one socket from the switch to its `Close` event.
pub(crate) async fn run(hub: Arc<WsHub>, on: OnUpgrade, a: Accepted) {
    let Accepted {
        local,
        opts,
        remote,
        permit,
        count,
        token,
    } = a;
    let _held = (permit, token);
    let worker = count.worker();
    let Some(sink) = hub.sink() else { return };
    let upgraded = match on.await {
        Ok(u) => u,
        Err(e) => {
            debug!(error = %e, "websocket switch failed");
            // The worker allocated the id in its 101: this Close is how it frees it.
            sink.deliver(
                worker,
                local,
                WsEvent::Close {
                    code: 1006,
                    reason: String::new(),
                },
            )
            .await;
            return;
        }
    };
    let cfg = WebSocketConfig::default()
        .read_buffer_size(8 * 1024)
        .write_buffer_size(16 * 1024)
        .max_message_size(Some(opts.max_payload))
        .max_frame_size(Some(opts.max_payload));
    let ws =
        WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(cfg)).await;
    let (sock, rx) = hub.register(worker, local, opts, remote);

    let (lane, lane_rx) = mpsc::unbounded_channel();
    let events = tokio::spawn(events(Arc::clone(&sink), worker, local, lane_rx));
    let _ = lane.send((WsEvent::Open, None));

    let (tx_half, rx_half) = ws.split();
    let mut writer = tokio::spawn(write(tx_half, rx, Arc::clone(&sock), lane.clone()));
    let end = read(rx_half, &sock, &hub, &lane).await;

    sock.mark_closed();
    hub.unregister(&sock);
    let sent = if end.flush_close {
        // An error close (1009, 1007, 1002): let the writer put the close frame out, briefly.
        match tokio::time::timeout(CLOSE_WAIT, &mut writer).await {
            Ok(Ok(sent)) => sent,
            _ => {
                writer.abort();
                None
            }
        }
    } else {
        writer.abort();
        writer.await.ok().flatten()
    };
    let (code, reason) = match (end.peer, sent, end.terminated) {
        (_, _, true) => (1006, String::new()),
        (Some(peer), _, _) => peer,
        (None, Some(f), _) => (u16::from(f.code), f.reason.to_string()),
        (None, None, _) => (1006, String::new()),
    };
    let _ = lane.send((WsEvent::Close { code, reason }, None));
    drop(lane);
    let _ = events.await;
    drop(count);
}

/// The events lane: `deliver` in order, the futures settle in any order; a permit returns a read credit.
async fn events(
    sink: Arc<dyn WsSink>,
    worker: u32,
    local: u32,
    mut rx: mpsc::UnboundedReceiver<(WsEvent, Option<OwnedSemaphorePermit>)>,
) {
    let mut inflight = FuturesUnordered::new();
    loop {
        tokio::select! {
            biased;
            Some(()) = inflight.next(), if !inflight.is_empty() => {}
            ev = rx.recv() => match ev {
                Some((ev, credit)) => {
                    let f = sink.deliver(worker, local, ev);
                    inflight.push(async move {
                        f.await;
                        drop(credit);
                    });
                }
                None => break,
            }
        }
    }
    while inflight.next().await.is_some() {}
}

/// How the reader ended.
struct End {
    /// The peer's close: its code (1005 without one) and reason.
    peer: Option<(u16, String)>,
    /// The server closed on a protocol error and the frame must still go out.
    flush_close: bool,
    /// `terminate` (no close frame either way).
    terminated: bool,
}

async fn read(
    mut rx: futures_util::stream::SplitStream<Ws>,
    sock: &Arc<Sock>,
    hub: &WsHub,
    lane: &Lane,
) -> End {
    let opts = sock.opts;
    let credits = Arc::new(Semaphore::new(CREDITS));
    let mut held: Option<OwnedSemaphorePermit> = None;
    let mut end = End {
        peer: None,
        flush_close: false,
        terminated: false,
    };
    let idle = (opts.idle_s > 0).then(|| Duration::from_secs(u64::from(opts.idle_s)));
    let mut idle_at = idle.map(|d| tokio::time::Instant::now() + d);
    let mut ping = (opts.ping_s > 0).then(|| {
        let p = Duration::from_secs(u64::from(opts.ping_s));
        let mut iv = tokio::time::interval_at(tokio::time::Instant::now() + p, p);
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        iv
    });
    let mut drain = hub.drain_rx();
    let mut drain_seen = false;
    // Set once the server started closing: the peer's close is waited for until then.
    let mut close_by: Option<tokio::time::Instant> = None;
    // `subscribe` marks the current value seen: a socket that switched after the drain began (its upgrade was in
    // the worker when it started) would never hear `changed`. It goes away at once instead (D10).
    if drain.borrow_and_update().is_some() {
        drain_seen = true;
        sock.close(1001, "going away");
        close_by = Some(close_deadline(&drain));
    }
    let far = || tokio::time::Instant::now() + Duration::from_secs(86_400 * 365);
    loop {
        let reading = held.is_some();
        tokio::select! {
            biased;
            _ = sock.kill.notified() => {
                end.terminated = true;
                return end;
            }
            // the app closed it: the peer gets CLOSE_WAIT (or the drain's deadline) to answer
            _ = sock.closing.notified(), if close_by.is_none() => {
                close_by = Some(close_deadline(&drain));
            }
            r = drain.changed(), if !drain_seen => {
                drain_seen = true;
                if r.is_ok() && drain.borrow().is_some() {
                    sock.close(1001, "going away");
                    close_by = Some(close_deadline(&drain));
                }
            }
            _ = tokio::time::sleep_until(close_by.unwrap_or_else(far)), if close_by.is_some() => return end,
            _ = tokio::time::sleep_until(idle_at.unwrap_or_else(far)), if reading && close_by.is_none() && idle_at.is_some() => {
                sock.close(1001, "idle timeout");
                close_by = Some(close_deadline(&drain));
            }
            _ = async { ping.as_mut().expect("guarded").tick().await }, if ping.is_some() && close_by.is_none() => {
                hub.ping(sock.id, Bytes::new());
            }
            p = Arc::clone(&credits).acquire_owned(), if !reading => {
                held = p.ok();
                // Time blocked on the worker is not the client's idleness.
                idle_at = idle.map(|d| tokio::time::Instant::now() + d);
            }
            m = rx.next(), if reading => {
                if let Some(d) = idle {
                    idle_at = Some(tokio::time::Instant::now() + d);
                }
                let ev = match m {
                    None => return end,
                    Some(Ok(Message::Text(t))) => WsEvent::Message(WsData::Text(t.as_str().to_owned())),
                    Some(Ok(Message::Binary(b))) => WsEvent::Message(WsData::Binary(b)),
                    // tungstenite queues the pong itself; the app still hears the ping
                    Some(Ok(Message::Ping(b))) => WsEvent::Ping(b),
                    Some(Ok(Message::Pong(b))) => WsEvent::Pong(b),
                    Some(Ok(Message::Close(f))) => {
                        end.peer = Some(match f {
                            Some(f) => (u16::from(f.code), f.reason.to_string()),
                            None => (1005, String::new()),
                        });
                        // tungstenite answers the close; the stream ends once that is out
                        continue;
                    }
                    Some(Ok(Message::Frame(_))) => continue,
                    Some(Err(e)) => {
                        let (code, reason) = match e {
                            WsError::Capacity(CapacityError::MessageTooLong { .. }) => (1009, "message too big"),
                            WsError::Utf8(_) => (1007, "invalid utf-8"),
                            WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake) | WsError::ConnectionClosed | WsError::AlreadyClosed | WsError::Io(_) => {
                                return end;
                            }
                            WsError::Capacity(_) | WsError::Protocol(_) => (1002, "protocol error"),
                            _ => return end,
                        };
                        debug!(error = %e, code, "websocket read error");
                        end.flush_close = sock.close(code, reason);
                        return end;
                    }
                };
                let _ = lane.send((ev, held.take()));
            }
        }
    }
}

/// When a close the server started gives up on the peer: CLOSE_WAIT, or the drain deadline when draining.
fn close_deadline(drain: &tokio::sync::watch::Receiver<Option<Instant>>) -> tokio::time::Instant {
    let wait = tokio::time::Instant::now() + CLOSE_WAIT;
    match *drain.borrow() {
        Some(d) => tokio::time::Instant::from_std(d)
            .min(wait)
            .max(tokio::time::Instant::now()),
        None => wait,
    }
}

/// The writer: queued frames out, flushed when the queue is empty; the close frame it sent, if any.
async fn write(
    mut tx: SplitSink<Ws, Message>,
    mut rx: mpsc::UnboundedReceiver<Out>,
    sock: Arc<Sock>,
    lane: Lane,
) -> Option<CloseFrame> {
    let mut unflushed = 0usize;
    while let Some(out) = rx.recv().await {
        match out {
            Out::Msg(m, n) => {
                if tx.feed(m).await.is_err() {
                    return None;
                }
                unflushed += n;
                if rx.is_empty() {
                    if tx.flush().await.is_err() {
                        return None;
                    }
                    if sock.flushed(std::mem::take(&mut unflushed)) {
                        let _ = lane.send((WsEvent::Drain, None));
                    }
                }
            }
            Out::Close(f) => {
                let _ = tx.send(Message::Close(Some(f.clone()))).await;
                return Some(f);
            }
        }
    }
    None
}
