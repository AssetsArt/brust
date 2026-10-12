//! The native half of the actions transport (F82): the heap request body and the oversize reply
//! of a `fetch` call cross through the claimed slot's `FetchCell`, on the worker's JS thread.
use bytes::Bytes;

use crate::config::Server;
use crate::dispatch::{CacheCell, FetchCell};

/// F82, on the worker's JS thread inside its `fetch` call for `slot`: the heap request body, once.
/// `None`: no such worker, the slot is not in a call, it is not a `fetch` call, no heap body was
/// sent, or it was already taken.
pub fn take_fetch_body(s: &Server, worker: u32, slot: u32) -> Option<Vec<u8>> {
    let taken = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let entry = s.core.host.pool.entry(worker)?;
        let mut g = entry.claimed_plan_cell(slot)?.lock();
        let cell = g.as_mut()?;
        if let Some(fc) = cell.downcast_mut::<FetchCell>() {
            return fc.body.take();
        }
        cell.downcast_mut::<CacheCell>()?.body.take()
    }))
    .ok()
    .flatten()?;
    Some(Vec::from(taken))
}

/// F82: hand Rust a response body too large for the slot. `false` = declined: the slot is not in a
/// `fetch` or `cache` call, the body is over that call's cap (`fetch`: `max_response_bytes`, and
/// no actions config declines; `cache`: the adapter's `max_body_bytes`), or a reply was already put.
pub fn put_fetch_reply(s: &Server, worker: u32, slot: u32, body: &[u8]) -> bool {
    let fetch_cap = s.core.actions.as_ref().map(|a| a.max_response_bytes);
    let cache_cap = s.core.l2.as_ref().map(|l| l.max_body_bytes);
    // Copy before taking the lock, unless no cell type could accept it.
    if body.len() > fetch_cap.max(cache_cap).unwrap_or(0) {
        return false;
    }
    let copy = Bytes::copy_from_slice(body);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(entry) = s.core.host.pool.entry(worker) else {
            return false;
        };
        let Some(cell) = entry.claimed_plan_cell(slot) else {
            return false;
        };
        let g = cell.lock();
        let Some(b) = g.as_ref() else {
            return false;
        };
        let (reply, cap) = if let Some(fc) = b.downcast_ref::<FetchCell>() {
            (&fc.reply, fetch_cap)
        } else if let Some(cc) = b.downcast_ref::<CacheCell>() {
            (&cc.reply, Some(cc.cap))
        } else {
            return false;
        };
        if cap.is_none_or(|c| copy.len() > c) {
            return false;
        }
        let mut reply = reply.lock();
        if reply.is_some() {
            return false;
        }
        *reply = Some(copy);
        true
    }))
    .unwrap_or(false)
}
