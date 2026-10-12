//! The native half of the actions transport (F82): the heap request body and the oversize reply
//! of a `fetch` call cross through the claimed slot's `FetchCell`, on the worker's JS thread.
use bytes::Bytes;

use crate::config::Server;
use crate::dispatch::FetchCell;

/// F82, on the worker's JS thread inside its `fetch` call for `slot`: the heap request body, once.
/// `None`: no such worker, the slot is not in a call, it is not a `fetch` call, no heap body was
/// sent, or it was already taken.
pub fn take_fetch_body(s: &Server, worker: u32, slot: u32) -> Option<Vec<u8>> {
    let taken = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let entry = s.core.host.pool.entry(worker)?;
        let mut g = entry.claimed_plan_cell(slot)?.lock();
        g.as_mut()?.downcast_mut::<FetchCell>()?.body.take()
    }))
    .ok()
    .flatten()?;
    Some(Vec::from(taken))
}

/// F82: hand Rust a response body too large for the slot. `false` = declined: no actions config,
/// `body.len() > max_response_bytes`, the slot is not in a `fetch` call, or a reply was already put.
pub fn put_fetch_reply(s: &Server, worker: u32, slot: u32, body: &[u8]) -> bool {
    let Some(a) = s.core.actions.as_ref() else {
        return false;
    };
    if body.len() > a.max_response_bytes {
        return false;
    }
    // Copy before taking the lock.
    let copy = Bytes::copy_from_slice(body);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(entry) = s.core.host.pool.entry(worker) else {
            return false;
        };
        let Some(cell) = entry.claimed_plan_cell(slot) else {
            return false;
        };
        let g = cell.lock();
        let Some(fc) = g.as_ref().and_then(|b| b.downcast_ref::<FetchCell>()) else {
            return false;
        };
        let mut reply = fc.reply.lock();
        if reply.is_some() {
            return false;
        }
        *reply = Some(copy);
        true
    }))
    .unwrap_or(false)
}
