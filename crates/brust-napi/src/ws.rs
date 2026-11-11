//! F529 plan §2c: the worker side of WebSockets. Each worker registers one socket tsfn (`registerSockets`); the
//! server's [`WsSink`] delivers socket events to the worker the socket is pinned to through it. The `ws*` calls are
//! synchronous and go straight to the server's [`brust_server::WsHub`].
use std::collections::HashMap;
use std::sync::Arc;

use napi::bindgen_prelude::{Buffer, Either, FnArgs, Function, Promise};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use parking_lot::RwLock;

use brust_server::ws::{BoxFuture, socket_id};
use brust_server::{WsData, WsEvent, WsSink};

use crate::dispatch::KindArg;

/// `(localId, ev, data, code, reason)`; `data` is a string (text message), a Buffer (binary message, ping, pong) or
/// null.
type SocketArgs = FnArgs<(u32, KindArg, Option<Either<String, Buffer>>, u32, String)>;

/// The handler may answer a Promise (awaited: it holds one of the socket's read credits) or nothing.
type SocketReturn = Either<Promise<()>, ()>;

/// The handler as JS declares it (`ev` a plain string there; the tsfn sends a [`KindArg`]).
type SocketFn<'a> =
    Function<'a, FnArgs<(u32, String, Option<Either<String, Buffer>>, u32, String)>, SocketReturn>;

/// The socket tsfn of one worker.
pub(crate) type SocketTsfn =
    ThreadsafeFunction<SocketArgs, SocketReturn, SocketArgs, napi::Status, false>;

/// The [`WsSink`] of a napi server: the socket tsfn of every registered worker.
#[derive(Default)]
pub(crate) struct NapiWsSink {
    workers: RwLock<HashMap<u32, Arc<SocketTsfn>>>,
}

impl NapiWsSink {
    pub(crate) fn register(&self, worker: u32, tsfn: SocketTsfn) {
        self.workers.write().insert(worker, Arc::new(tsfn));
    }
}

/// The JS name of an event (pure: unit-testable without a napi host).
fn event_name(ev: &WsEvent) -> &'static str {
    match ev {
        WsEvent::Open => "open",
        WsEvent::Message(_) => "message",
        WsEvent::Drain => "drain",
        WsEvent::Close { .. } => "close",
        WsEvent::Ping(_) => "ping",
        WsEvent::Pong(_) => "pong",
    }
}

/// The JS arguments of an event: `data` a string (text), a Buffer (binary, ping, pong) or null; `code`/`reason` only
/// on `close`.
fn args(local: u32, ev: WsEvent) -> SocketArgs {
    let name = event_name(&ev);
    let buf = |b: bytes::Bytes| Some(Either::B(Buffer::from(b.to_vec())));
    let (data, code, reason) = match ev {
        WsEvent::Message(WsData::Text(s)) => (Some(Either::A(s)), 0, String::new()),
        WsEvent::Message(WsData::Binary(b)) | WsEvent::Ping(b) | WsEvent::Pong(b) => {
            (buf(b), 0, String::new())
        }
        WsEvent::Close { code, reason } => (None, u32::from(code), reason),
        WsEvent::Open | WsEvent::Drain => (None, 0, String::new()),
    };
    (local, KindArg(name), data, code, reason).into()
}

impl WsSink for NapiWsSink {
    fn deliver(&self, worker: u32, local: u32, ev: WsEvent) -> BoxFuture<'static, ()> {
        let Some(tsfn) = self.workers.read().get(&worker).cloned() else {
            // The worker never registered its sockets (or went away): nobody can hear it.
            return Box::pin(async {});
        };
        // `call_with_return_value` queues the call NOW (`call_async` would only on its first poll): the server calls
        // `deliver` in event order and the worker must see that order. The callback never returns an error, so a
        // handler that throws (or whose answer is neither a Promise nor undefined) just settles the event.
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<Promise<()>>>();
        let status = tsfn.call_with_return_value(
            args(local, ev),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |r: napi::Result<SocketReturn>, _env| {
                let p = match r {
                    Ok(Either::A(p)) => Some(p),
                    Ok(Either::B(())) => None,
                    Err(e) => {
                        tracing::warn!(error = %e, "websocket handler threw");
                        None
                    }
                };
                let _ = tx.send(p);
                Ok(())
            },
        );
        if status != napi::Status::Ok {
            tracing::warn!(
                ?status,
                worker,
                "websocket event not delivered: worker gone"
            );
            return Box::pin(async {});
        }
        Box::pin(async move {
            if let Ok(Some(p)) = rx.await
                && let Err(e) = p.await
            {
                tracing::warn!(error = %e, "websocket handler rejected");
            }
        })
    }
}

fn data(d: Either<String, Buffer>) -> WsData {
    match d {
        Either::A(s) => WsData::Text(s),
        Either::B(b) => WsData::Binary(bytes::Bytes::copy_from_slice(&b)),
    }
}

fn bytes_of(d: Option<Buffer>) -> bytes::Bytes {
    d.map(|b| bytes::Bytes::copy_from_slice(&b))
        .unwrap_or_default()
}

/// The hub of the current server, or `None` before `startServer` (the calls then answer as for an unknown socket).
fn hub() -> Option<Arc<brust_server::WsHub>> {
    crate::server::current().ok().map(|s| s.ws_hub())
}

/// Register the calling worker's socket handler: `fn(localId, ev, data, code, reason)` for every event of a socket
/// pinned to `workerId` (the id `registerWorker` returned). `ev` is `open`, `message` (`data` a string or a Buffer),
/// `drain`, `close` (`code`, `reason`; a `close` may come without an `open` when the client left before the switch),
/// `ping` / `pong` (`data` a Buffer). A returned Promise is awaited: up to 8 unsettled events per socket, then the
/// socket is not read.
#[napi(
    ts_args_type = "workerId: number, fn: (localId: number, ev: 'open' | 'message' | 'drain' | 'close' | 'ping' | 'pong', data: string | Buffer | null, code: number, reason: string) => Promise<void> | void"
)]
pub fn register_sockets(worker_id: u32, f: SocketFn<'_>) -> napi::Result<()> {
    let sink = crate::server::ws_sink()?;
    let tsfn: SocketTsfn = f
        .build_threadsafe_function::<SocketArgs>()
        .build_callback(|ctx| Ok(ctx.value))?;
    sink.register(worker_id, tsfn);
    Ok(())
}

/// Queue a message: the bytes queued (> 0), `-1` queued past the back-pressure limit, `0` dropped (unknown or closed
/// socket, or already past the limit).
#[napi(ts_args_type = "workerId: number, localId: number, data: string | Buffer")]
pub fn ws_send(worker_id: u32, local_id: u32, d: Either<String, Buffer>) -> i64 {
    hub().map_or(0, |h| h.send(socket_id(worker_id, local_id), data(d)))
}

#[napi]
pub fn ws_close(worker_id: u32, local_id: u32, code: u32, reason: String) {
    if let Some(h) = hub() {
        h.close(
            socket_id(worker_id, local_id),
            u16::try_from(code).unwrap_or(1000),
            &reason,
        );
    }
}

#[napi]
pub fn ws_terminate(worker_id: u32, local_id: u32) {
    if let Some(h) = hub() {
        h.terminate(socket_id(worker_id, local_id));
    }
}

/// True when the socket is open (and now subscribed).
#[napi]
pub fn ws_subscribe(worker_id: u32, local_id: u32, topic: String) -> bool {
    hub().is_some_and(|h| h.subscribe(socket_id(worker_id, local_id), &topic))
}

/// True when the socket was subscribed.
#[napi]
pub fn ws_unsubscribe(worker_id: u32, local_id: u32, topic: String) -> bool {
    hub().is_some_and(|h| h.unsubscribe(socket_id(worker_id, local_id), &topic))
}

#[napi]
pub fn ws_is_subscribed(worker_id: u32, local_id: u32, topic: String) -> bool {
    hub().is_some_and(|h| h.is_subscribed(socket_id(worker_id, local_id), &topic))
}

#[napi]
pub fn ws_subscriptions(worker_id: u32, local_id: u32) -> Vec<String> {
    hub()
        .map(|h| h.subscriptions(socket_id(worker_id, local_id)))
        .unwrap_or_default()
}

#[napi]
pub fn ws_ping(worker_id: u32, local_id: u32, data: Option<Buffer>) {
    if let Some(h) = hub() {
        h.ping(socket_id(worker_id, local_id), bytes_of(data));
    }
}

#[napi]
pub fn ws_pong(worker_id: u32, local_id: u32, data: Option<Buffer>) {
    if let Some(h) = hub() {
        h.pong(socket_id(worker_id, local_id), bytes_of(data));
    }
}

/// The peer's IP address (`""` for an unknown socket).
#[napi]
pub fn ws_remote_address(worker_id: u32, local_id: u32) -> String {
    hub()
        .and_then(|h| h.remote_addr(socket_id(worker_id, local_id)))
        .map(|a| a.ip().to_string())
        .unwrap_or_default()
}

/// Queue `data` on every socket subscribed to `topic`, on any worker. A socket publishing passes its own ids as
/// `except` (skipped unless its route set `publishToSelf`); a server-level publish passes none. The bytes queued in
/// all, 0 when nobody got it.
#[napi(
    ts_args_type = "topic: string, data: string | Buffer, exceptWorkerId?: number, exceptLocalId?: number"
)]
pub fn ws_publish(
    topic: String,
    d: Either<String, Buffer>,
    except_worker_id: Option<u32>,
    except_local_id: Option<u32>,
) -> i64 {
    let except = match (except_worker_id, except_local_id) {
        (Some(w), Some(l)) => Some(socket_id(w, l)),
        _ => None,
    };
    hub().map_or(0, |h| h.publish(&topic, data(d), except))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_map_to_the_js_names() {
        assert_eq!(event_name(&WsEvent::Open), "open");
        assert_eq!(
            event_name(&WsEvent::Message(WsData::Text("x".into()))),
            "message"
        );
        assert_eq!(event_name(&WsEvent::Drain), "drain");
        let close = WsEvent::Close {
            code: 1000,
            reason: "r".into(),
        };
        assert_eq!(event_name(&close), "close");
        assert_eq!(event_name(&WsEvent::Ping(bytes::Bytes::new())), "ping");
        assert_eq!(event_name(&WsEvent::Pong(bytes::Bytes::new())), "pong");
    }
}
