//! `WasmHost`: the [`Host`] on Cloudflare Workers — the app's JS (loader, jobs, Elysia actions) in
//! the same isolate through `brust-app.js`, the single-thread local caches, `Date.now()` time.
//! Static files are Workers Static Assets' (a miss reaches core's 404).
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use brust_core::body::is_framing_header;
use brust_core::cache::local::{LocalJobs, LocalL1};
use brust_core::host::{
    ActionBody, ActionCall, ActionReply, CallError, Clock, Host, JsClock, ReadErr, StaticRoot,
};
use brust_core::l2::{L2Counters, L2Key, L2Lookup, L2Page, L2Probe, L2SetMeta};
use brust_core::plan::{PlanSeed, PlannedCall};
use brust_core::protocol::{
    CacheReplyMeta, JobsRequest, JobsResponse, LoaderRequest, LoaderResponse,
};
use bytes::Bytes;
use futures_util::StreamExt;
use http::{HeaderMap, Response};
use std::sync::Arc;
use std::time::Duration;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

use crate::bridge::{js_action, js_jobs, js_loader, js_string};
use crate::capped::Capped;
use crate::head::{action_request_headers, action_url};

/// The `Extensions` mark of a `Built` action reply whose body is the app's JS `Response`, kept in
/// `WasmHost::replies` until the adapter answers with it (R4).
#[derive(Clone, Copy, Debug)]
pub struct ReplyId(pub u64);

/// The per-isolate host. `replies` leaks one entry if a panic lands between `action` and the
/// adapter's `take` (the isolate keeps serving).
#[derive(Default)]
pub struct WasmHost {
    clock: JsClock,
    replies: RefCell<HashMap<u64, web_sys::Response>>,
    next: Cell<u64>,
    /// The cache adapter bridge `install` returned (cache-adapter R11, R14); `None` = no L2.
    cache: RefCell<Option<CacheBridge>>,
}

/// The JS side of the cache adapter (`server-handlers.ts` `install` → `{ cache }`):
/// `get(key) → Promise<{json, body}>` (`json` = a `CacheReplyMeta`), `set(key, json, body)` (defers
/// itself with `waitUntil`), `since(seq) → Promise<string>` (an `EpochSince` JSON; pull broadcasts).
#[derive(Clone)]
pub struct CacheBridge {
    pub get: js_sys::Function,
    pub set: js_sys::Function,
    pub since: Option<js_sys::Function>,
    /// The bridge object: `origin` is read from it lazily (a Worker may not draw random values at
    /// start, so the JS side makes it on first use, inside a request).
    pub obj: wasm_bindgen::JsValue,
    pub get_timeout: Duration,
}

impl CacheBridge {
    /// This isolate's origin (`crypto.randomUUID()`, made on first read).
    pub fn origin(&self) -> Option<String> {
        js_sys::Reflect::get(&self.obj, &"origin".into())
            .ok()?
            .as_string()
    }
}

impl WasmHost {
    /// The app's response held for `id`.
    pub fn take(&self, id: ReplyId) -> Option<web_sys::Response> {
        self.replies.borrow_mut().remove(&id.0)
    }

    pub fn set_cache(&self, b: CacheBridge) {
        *self.cache.borrow_mut() = Some(b);
    }

    /// A clone of the bridge: no borrow is held across an await (a JS action may re-enter).
    pub fn cache(&self) -> Option<CacheBridge> {
        self.cache.borrow().clone()
    }
}

/// One `get` answer → the lookup.
fn lookup_of(v: wasm_bindgen::JsValue) -> L2Lookup {
    let field = |k: &str| js_sys::Reflect::get(&v, &k.into()).ok();
    let Some(json) = field("json").and_then(|j| j.as_string()) else {
        return L2Lookup::Failed("cache get answered no json".into());
    };
    let m: CacheReplyMeta = match serde_json::from_str(&json) {
        Ok(m) => m,
        Err(e) => return L2Lookup::Failed(format!("cache get: {e}")),
    };
    if let Some(e) = m.error {
        return L2Lookup::Failed(e);
    }
    if m.hit != Some(true) {
        return L2Lookup::Miss { stamp: m.stamp };
    }
    let (Some(status), Some(body)) = (
        m.status,
        field("body").and_then(|b| b.dyn_into::<js_sys::Uint8Array>().ok()),
    ) else {
        return L2Lookup::Failed("cache hit without status or body".into());
    };
    L2Lookup::Hit {
        page: L2Page {
            status,
            headers: m.headers,
            body: Bytes::from(body.to_vec()),
        },
        stamp: m.stamp,
        entry_stamp: m.entry_stamp,
        stored_at_ms: m.stored_at,
    }
}

impl Clock for WasmHost {
    fn now_ns(&self) -> u64 {
        self.clock.now_ns()
    }

    fn wall_ms(&self) -> u64 {
        js_sys::Date::now() as u64
    }
}

/// A `loader`/`jobs` promise's string: a rejection is `Rejected`, anything but a string `BadResponse`.
async fn text(call: Result<js_sys::Promise, wasm_bindgen::JsValue>) -> Result<String, CallError> {
    let p = call.map_err(|e| CallError::Rejected(js_string(e)))?;
    let v = JsFuture::from(p)
        .await
        .map_err(|e| CallError::Rejected(js_string(e)))?;
    v.as_string()
        .ok_or_else(|| CallError::BadResponse("worker answered a non-string".into()))
}

fn bad(e: impl std::fmt::Display) -> CallError {
    CallError::BadResponse(e.to_string())
}

impl Host for WasmHost {
    type Body = worker::Request;
    type L1 = LocalL1<JsClock>;
    type Jobs = LocalJobs<JsClock>;
    /// Loader and jobs are two direct in-isolate calls (spec R4).
    const PLAN_OFFER: bool = false;

    async fn loader(
        &self,
        req: &LoaderRequest<'_>,
        _offer: Option<PlanSeed>,
    ) -> Result<(LoaderResponse, Option<PlannedCall>), CallError> {
        let json = serde_json::to_string(req).map_err(bad)?;
        let s = text(js_loader(&json)).await?;
        Ok((serde_json::from_str(&s).map_err(bad)?, None))
    }

    async fn jobs(&self, req: &JobsRequest<'_>) -> Result<JobsResponse, CallError> {
        let json = serde_json::to_string(req).map_err(bad)?;
        let s = text(js_jobs(&json)).await?;
        serde_json::from_str(&s).map_err(bad)
    }

    /// The body in chunks, refused the moment it passes `cap` (and up front by a declared length).
    /// Never `Slow`: Workers bounds a request's wall time itself.
    async fn read_body(&self, mut body: worker::Request, cap: usize) -> Result<Bytes, ReadErr> {
        let mut c = Capped::new(cap);
        c.declared(
            body.headers()
                .get("content-length")
                .ok()
                .flatten()
                .as_deref(),
        )?;
        if body.inner().body().is_none() {
            return Ok(Bytes::new());
        }
        let mut s = body.stream().map_err(|_| ReadErr::Io)?;
        while let Some(chunk) = s.next().await {
            c.push(&chunk.map_err(|_| ReadErr::Io)?)?;
        }
        Ok(c.finish())
    }

    /// The app's `action(Request)`; its `Response` stays here and the core gets `Built` with its
    /// status and headers (R4).
    async fn action(
        &self,
        call: ActionCall<'_, worker::Request>,
    ) -> Result<ActionReply, CallError> {
        let js = |e| CallError::BadResponse(js_string(e));
        let headers = web_sys::Headers::new().map_err(js)?;
        for (n, v) in action_request_headers(call.headers, call.authority) {
            headers.append(&n, &v).map_err(js)?;
        }
        let init = web_sys::RequestInit::new();
        init.set_method(call.method);
        init.set_headers(&headers);
        // `STREAM_BODY` is off here: core hands a buffered body or none.
        if !matches!(call.method, "GET" | "HEAD")
            && let ActionBody::Buffered(b) = &call.body
        {
            init.set_body(&js_sys::Uint8Array::from(&b[..]));
        }
        let url = action_url(call.headers, call.authority, call.full);
        let req = web_sys::Request::new_with_str_and_init(&url, &init).map_err(js)?;
        let p = js_action(&req).map_err(|e| CallError::Rejected(js_string(e)))?;
        let resp: web_sys::Response = JsFuture::from(p)
            .await
            .map_err(|e| CallError::Rejected(js_string(e)))?
            .dyn_into()
            .map_err(|_| CallError::BadResponse("action answered a non-Response".into()))?;
        let mut hm = HeaderMap::new();
        for e in resp.headers().entries() {
            let Ok(e) = e else { continue };
            let pair: js_sys::Array = e.unchecked_into();
            let (Some(k), Some(v)) = (pair.get(0).as_string(), pair.get(1).as_string()) else {
                continue;
            };
            if is_framing_header(&k) {
                continue;
            }
            if let (Ok(n), Ok(v)) = (
                http::HeaderName::from_bytes(k.as_bytes()),
                http::HeaderValue::from_str(&v),
            ) {
                hm.append(n, v);
            }
        }
        let id = self.next.get();
        self.next.set(id + 1);
        let mut out = Response::new(Bytes::new());
        *out.status_mut() = http::StatusCode::from_u16(resp.status())
            .unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
        *out.headers_mut() = hm;
        out.extensions_mut().insert(ReplyId(id));
        self.replies.borrow_mut().insert(id, resp);
        Ok(ActionReply::Built(out))
    }

    async fn static_file(
        &self,
        _root: StaticRoot,
        _rel: &str,
        _headers: &HeaderMap,
        _head: bool,
    ) -> Option<Response<Bytes>> {
        None
    }

    /// `store.get` raced against `get_timeout` (R7: fail-open; the JS promise is left to settle).
    async fn l2_get(&self, p: &L2Probe<'_>) -> L2Lookup {
        let Some(b) = self.cache() else {
            return L2Lookup::Off;
        };
        let promise = match b
            .get
            .call1(&wasm_bindgen::JsValue::NULL, &p.key.0.as_str().into())
        {
            Ok(v) => match v.dyn_into::<js_sys::Promise>() {
                Ok(p) => p,
                Err(_) => return L2Lookup::Failed("cache get returned no promise".into()),
            },
            Err(e) => return L2Lookup::Failed(js_string(e)),
        };
        let get = JsFuture::from(promise);
        let delay = worker::Delay::from(b.get_timeout);
        futures_util::pin_mut!(get, delay);
        match futures_util::future::select(get, delay).await {
            futures_util::future::Either::Left((Ok(v), _)) => lookup_of(v),
            futures_util::future::Either::Left((Err(e), _)) => L2Lookup::Failed(js_string(e)),
            futures_util::future::Either::Right(_) => L2Lookup::Timeout,
        }
    }

    /// `store.set` handed to JS, which defers it with `waitUntil` and counts `sets`/`set_refused`.
    fn l2_set(&self, key: L2Key, page: L2Page, meta: L2SetMeta, counters: &Arc<L2Counters>) {
        let Some(b) = self.cache() else { return };
        let json = serde_json::json!({
            "status": page.status,
            "headers": page.headers,
            "meta": {"ttlMs": meta.ttl_ms, "tags": meta.tags, "method": meta.method, "path": meta.path, "stamp": meta.stamp},
        })
        .to_string();
        let body = js_sys::Uint8Array::from(&page.body[..]);
        if b.set
            .call3(
                &wasm_bindgen::JsValue::NULL,
                &key.0.as_str().into(),
                &json.into(),
                &body,
            )
            .is_err()
        {
            counters.bump("errors");
        }
    }
}
