//! The per-request epoch sync (cache adapters L6): a GET/HEAD that finds the cursor due awaits one
//! `since(seq)` (500 ms cap, single-flight; concurrent requests do not wait) and applies it —
//! foreign events replayed through `Core::l2_replay` (tier 1 + the floor, never re-published, L3),
//! a lost history cleared. Fail-open: a failed poll keeps tier 1 (`poll_errors`).
use std::cell::RefCell;
use std::time::Duration;

use brust_core::core::Core;
use futures_util::future::{Either, select};
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

use super::cursor::{Cursor, POLL_TIMEOUT_MS, Plan, parse_since};
use crate::bridge::js_string;
use crate::host::WasmHost;

thread_local! {
    static CURSOR: RefCell<Option<Cursor>> = const { RefCell::new(None) };
    /// The last `console.warn` of a failed poll (ms): one per minute.
    static WARNED: RefCell<f64> = const { RefCell::new(f64::NEG_INFINITY) };
}

/// At boot, for an adapter with a pull broadcast. The origin is learnt on the first poll.
pub fn init(interval_ms: u64) {
    CURSOR.with(|c| *c.borrow_mut() = Some(Cursor::new(String::new(), interval_ms)));
}

pub async fn maybe_sync(core: &Core<WasmHost>) {
    let now = js_sys::Date::now() as u64;
    let unknown = CURSOR.with(|c| c.borrow().as_ref().is_some_and(|c| c.origin.is_empty()));
    if unknown && let Some(o) = core.host.cache().and_then(|b| b.origin()) {
        CURSOR.with(|c| {
            if let Some(c) = c.borrow_mut().as_mut() {
                c.origin = o;
            }
        });
    }
    // No borrow survives this statement: the await below may run a JS action that re-enters.
    let Some(from) = CURSOR.with(|c| c.borrow_mut().as_mut().and_then(|c| c.begin(now))) else {
        return;
    };
    let n = &core.l2_counters;
    n.bump("epoch_polls");
    match poll(core, from).await {
        Ok(json) => match parse_since(&json) {
            Ok(r) => {
                let plan = CURSOR.with(|c| c.borrow_mut().as_mut().map(|c| c.apply(r)));
                if let Some(plan) = plan {
                    apply(core, plan);
                }
            }
            Err(e) => failed(core, &e),
        },
        Err(e) => failed(core, &e),
    }
}

async fn poll(core: &Core<WasmHost>, from: u64) -> Result<String, String> {
    let since = core.host.cache().and_then(|b| b.since).ok_or("no since")?;
    let p = since
        .call1(&wasm_bindgen::JsValue::NULL, &(from as f64).into())
        .map_err(js_string)?
        .dyn_into::<js_sys::Promise>()
        .map_err(|_| "since returned no promise".to_string())?;
    let call = JsFuture::from(p);
    let cap = worker::Delay::from(Duration::from_millis(POLL_TIMEOUT_MS));
    futures_util::pin_mut!(call, cap);
    match select(call, cap).await {
        Either::Left((Ok(v), _)) => v
            .as_string()
            .ok_or_else(|| "since answered a non-string".into()),
        Either::Left((Err(e), _)) => Err(js_string(e)),
        Either::Right(_) => Err(format!("since timed out after {POLL_TIMEOUT_MS} ms")),
    }
}

fn failed(core: &Core<WasmHost>, e: &str) {
    CURSOR.with(|c| {
        if let Some(c) = c.borrow_mut().as_mut() {
            c.fail();
        }
    });
    core.l2_counters.bump("poll_errors");
    let now = js_sys::Date::now();
    let warn = WARNED.with(|w| {
        let mut w = w.borrow_mut();
        let due = now - *w >= 60_000.0;
        if due {
            *w = now;
        }
        due
    });
    if warn {
        web_sys::console::warn_1(&format!("brust: cache adapter epoch poll failed: {e}").into());
    }
}

fn apply(core: &Core<WasmHost>, plan: Plan) {
    let n = &core.l2_counters;
    match plan {
        Plan::Adopt => {}
        Plan::Replay {
            events,
            skipped_own,
        } => {
            for _ in 0..skipped_own {
                n.bump("skipped_own");
            }
            for (seq, args) in events {
                core.l2_replay(args, Some(seq));
                n.bump("received");
            }
        }
        Plan::Clear { same_gen, seq } => {
            core.clear_local();
            core.l2_floor.with(|f| {
                if same_gen {
                    f.clear_at(seq);
                } else {
                    f.reset();
                }
            });
        }
    }
}
