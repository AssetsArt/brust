//! The Worker's entry points: `#[event(start)]` boots one `Core<WasmHost>` per isolate (R11: a boot
//! error throws, so the module refuses to load); `#[event(fetch)]` runs a request through it.
use std::cell::{Cell, OnceCell};
use std::panic::AssertUnwindSafe;

use brust_core::body;
use brust_core::core::Core;
use brust_core::host::RequestHead;
use brust_core::manifest::Manifest;
use futures_util::FutureExt;
use worker::{Context, Env, Request, Response, event};

use crate::host::{ReplyId, WasmHost};
use crate::{bridge, config, epoch, head, log, respond};

thread_local! {
    static CORE: OnceCell<&'static Core<WasmHost>> = const { OnceCell::new() };
    /// `CONFIG.stats`: `/_brust/cache/stats` is served (R11).
    static STATS: Cell<bool> = const { Cell::new(false) };
}

/// The e2e build's tier-1 clear route (forces the L2 path in `tests/cf/cache-adapter.test.ts`).
const E2E_L1_CLEAR: &str = "/__brust_e2e/l1-clear";

#[event(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&info.to_string().into());
    }));
    log::init();
    if let Err(e) = boot() {
        let e = format!("brust: boot failed: {e}");
        web_sys::console::error_1(&e.as_str().into());
        wasm_bindgen::throw_str(&e);
    }
}

fn boot() -> Result<(), String> {
    let parsed = config::parse_all(&bridge::config())?;
    let (cfg, stats, epoch_cfg) = (parsed.core, parsed.stats, parsed.epoch);
    let loaded = Manifest::from_parts(&bridge::manifest(), &bridge::templates())
        .map_err(|e| format!("manifest: {e}"))?;
    let core: &'static Core<WasmHost> =
        Box::leak(Box::new(Core::new(WasmHost::default(), loaded, cfg)?));
    CORE.with(|c| c.set(core))
        .map_err(|_| "booted twice".to_string())?;
    STATS.with(|s| s.set(stats));
    bridge::install(core)?;
    if let (Some(e), Some(b)) = (epoch_cfg, core.host.cache())
        && b.since.is_some()
    {
        epoch::sync::init(e.interval_ms);
    }
    Ok(())
}

/// The last-resort 500 (a panic, or no core).
fn internal_error() -> worker::Result<Response> {
    Ok(Response::from(
        respond::to_web(
            body::resp(
                500,
                "text/plain",
                &[],
                b"500 Internal Server Error".to_vec(),
            ),
            false,
        )
        .map_err(js)?,
    ))
}

fn js(e: wasm_bindgen::JsValue) -> worker::Error {
    worker::Error::JsError(bridge::js_string(e))
}

#[event(fetch)]
async fn fetch(req: Request, _env: Env, _ctx: Context) -> worker::Result<Response> {
    let Some(core) = CORE.with(|c| c.get().copied()) else {
        return internal_error();
    };
    let method = req.inner().method();
    let url = req.inner().url();
    let Some((authority, full)) = head::split_url(&url) else {
        return internal_error();
    };
    let headers = head::header_map(req.headers().entries());
    let origin = core
        .cors_enabled()
        .then(|| headers.get(http::header::ORIGIN).cloned())
        .flatten();
    let is_head = method == "HEAD";
    let resp = if !STATS.with(Cell::get) && head::is_stats(&method, &full) {
        body::resp(404, "text/plain", &[], b"not found".to_vec())
    } else {
        let rq = RequestHead {
            method: &method,
            full: &full,
            headers: &headers,
            authority: Some(authority),
        };
        let handled = async {
            // The e2e build's deliberate panic runs inside the per-request guard it exercises.
            if option_env!("BRUST_WASM_E2E").is_some() && full == "/__brust_e2e/panic" {
                panic!("brust e2e: deliberate panic");
            }
            if option_env!("BRUST_WASM_E2E").is_some() && full == E2E_L1_CLEAR {
                core.clear_local();
                return body::resp(204, "text/plain", &[], Vec::new());
            }
            // The cache adapter's pull broadcast (L6): at most one poll per interval, before the
            // L1 probe of a page request, inside this guard.
            if method == "GET" || method == "HEAD" {
                epoch::sync::maybe_sync(core).await;
            }
            core.handle(rq, req).await
        };
        match AssertUnwindSafe(handled).catch_unwind().await {
            Ok(r) => r,
            // The panic hook already printed it.
            Err(_) => return internal_error(),
        }
    };
    let (mut parts, bytes) = resp.into_parts();
    core.finish(origin.as_ref(), &mut parts.headers);
    let web = match parts.extensions.get::<ReplyId>().copied() {
        Some(id) => match core.host.take(id) {
            Some(js_resp) => respond::rewrap(js_resp, &parts, is_head),
            None => return internal_error(),
        },
        None => respond::to_web(http::Response::from_parts(parts, bytes), is_head),
    };
    Ok(Response::from(web.map_err(js)?))
}
