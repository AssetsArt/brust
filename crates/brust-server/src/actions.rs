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

/// F82 + L10: hand Rust a response body too large for the slot. `false` = declined.
///
/// - Slot in a `fetch` or `cache` call: the body goes to that call's reply cell, capped by that
///   call (`fetch`: `max_response_bytes`, and no actions config declines; `cache`: the adapter's
///   `max_body_bytes`); a reply already put declines.
/// - Slot in any other claimed call (`loader`, `jobs`, the planned reply): the body is the call's
///   heap reply, capped by `max_loader_response_bytes`; the worker then writes the 5-byte heap
///   marker into the slot (`dispatch::decode_heap_marker`). A second put declines.
/// - Idle slot, over the cap: declined.
pub fn put_fetch_reply(s: &Server, worker: u32, slot: u32, body: &[u8]) -> bool {
    let fetch_cap = s.core.actions.as_ref().map(|a| a.max_response_bytes);
    let cache_cap = s.core.l2.as_ref().map(|l| l.max_body_bytes);
    let loader_cap = s.core.host.max_loader_response_bytes;
    // Copy before taking the lock, unless no cell type could accept it.
    if body.len() > fetch_cap.max(cache_cap).unwrap_or(0).max(loader_cap) {
        return false;
    }
    let copy = Bytes::copy_from_slice(body);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(entry) = s.core.host.pool.entry(worker) else {
            return false;
        };
        let Some(claimed) = entry.claimed_slot(slot) else {
            return false;
        };
        let g = claimed.plan.lock();
        let typed = g.as_ref().and_then(|b| {
            if let Some(fc) = b.downcast_ref::<FetchCell>() {
                Some((&fc.reply, fetch_cap))
            } else {
                b.downcast_ref::<CacheCell>()
                    .map(|cc| (&cc.reply, Some(cc.cap)))
            }
        });
        let (put, cap) = match typed {
            Some((reply, cap)) => (reply as &parking_lot::Mutex<Option<Bytes>>, cap),
            None => (&claimed.heap_reply, Some(loader_cap)),
        };
        if cap.is_none_or(|c| copy.len() > c) {
            return false;
        }
        let mut put = put.lock();
        if put.is_some() {
            return false;
        }
        *put = Some(copy);
        true
    }))
    .unwrap_or(false)
}
