//! F529: WebSockets under the actions prefix, owned here. Rust validates the handshake, answers the 101, runs the frames
//! (tokio-tungstenite on the upgraded connection), pings, the idle timeout, the payload and outbound limits, the topics
//! and the drain; the app's handlers run in the Bun worker that accepted the upgrade, reached through a [`WsSink`].
//!
//! A socket is pinned for life to that worker (its Elysia closures live in that worker's heap): its id is
//! `(worker << 32) | local`, `local` being the id the worker allocated in its `101` answer. Other workers reach it only
//! through topics ([`WsHub::publish`]).
use std::sync::Arc;

use bytes::Bytes;

mod handshake;
mod hub;
mod socket;
pub(crate) mod upgrade;

pub use futures_util::future::BoxFuture;
pub use hub::WsHub;
pub(crate) use hub::WsPick;

/// `(worker as u64) << 32 | local`.
pub type SocketId = u64;

/// The socket id of `local` on `worker`.
pub fn socket_id(worker: u32, local: u32) -> SocketId {
    (u64::from(worker) << 32) | u64::from(local)
}

/// The `(worker, local)` halves of a [`SocketId`].
pub fn socket_parts(id: SocketId) -> (u32, u32) {
    ((id >> 32) as u32, id as u32)
}

/// One message payload: a text frame or a binary one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsData {
    Text(String),
    Binary(Bytes),
}

impl WsData {
    /// The payload bytes, the unit of the outbound limit and of [`WsHub::send`]'s answer.
    pub fn len(&self) -> usize {
        match self {
            Self::Text(s) => s.len(),
            Self::Binary(b) => b.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What the pinned worker hears about a socket, in this order: `Open` once, then messages, pings, pongs and drains as
/// they happen, then `Close` once. A `Close` without an `Open` means the client went away between the `101` and the
/// switch (the worker allocated the id; this is its only chance to free it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsEvent {
    Open,
    Message(WsData),
    /// The outbound queue emptied after a send answered `-1` or `0` (back-pressure).
    Drain,
    /// `code` is the peer's close code, 1005 for a close frame without one, 1006 when the connection ended without a
    /// close frame (or the server terminated it), else the code the server closed with.
    Close {
        code: u16,
        reason: String,
    },
    Ping(Bytes),
    Pong(Bytes),
}

/// The worker side, implemented by brust-napi.
pub trait WsSink: Send + Sync + 'static {
    /// Deliver to the pinned worker; the future resolves when the JS handler's promise settles.
    ///
    /// Must hand the event over before it returns (the future only waits for the handler): a socket calls `deliver`
    /// for its events in order with up to 8 unsettled, and the worker must see them in that order.
    fn deliver(&self, worker: u32, local: u32, ev: WsEvent) -> BoxFuture<'static, ()>;
}

tokio::task_local! {
    /// Set by [`upgrade`] around the core call of a WebSocket upgrade request: the pool's claim reads it to put the
    /// call on the worker with the fewest open sockets and records which worker that was (D5).
    pub(crate) static WS_PICK: Arc<WsPick>;
}
