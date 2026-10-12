//! `WasmHost`: the [`Host`] on Cloudflare Workers — the app's JS (loader, jobs, Elysia actions) in
//! the same isolate through `brust-app.js`, the single-thread local caches, `Date.now()` time.
//! Static files are Workers Static Assets' (a miss reaches core's 404).
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use brust_core::body::is_framing_header;
use brust_core::cache::local::{LocalJobs, LocalL1};
use brust_core::host::{
    ActionCall, ActionReply, CallError, Clock, Host, JsClock, ReadErr, StaticRoot,
};
use brust_core::plan::{PlanSeed, PlannedCall};
use brust_core::protocol::{JobsRequest, JobsResponse, LoaderRequest, LoaderResponse};
use bytes::Bytes;
use futures_util::StreamExt;
use http::{HeaderMap, Response};
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

use crate::bridge::{js_action, js_jobs, js_loader, js_string};
use crate::capped::Capped;
use crate::head::action_url;

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
}

impl WasmHost {
    /// The app's response held for `id`.
    pub fn take(&self, id: ReplyId) -> Option<web_sys::Response> {
        self.replies.borrow_mut().remove(&id.0)
    }
}

impl Clock for WasmHost {
    fn now_ns(&self) -> u64 {
        self.clock.now_ns()
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
    async fn action(&self, call: ActionCall<'_>) -> Result<ActionReply, CallError> {
        let js = |e| CallError::BadResponse(js_string(e));
        let headers = web_sys::Headers::new().map_err(js)?;
        for (n, v) in call.headers {
            if is_framing_header(n.as_str()) {
                continue;
            }
            headers
                .append(n.as_str(), &String::from_utf8_lossy(v.as_bytes()))
                .map_err(js)?;
        }
        // R8: HTTP/2 carries the host in `:authority`, not a `host` header.
        if !call.headers.contains_key(http::header::HOST)
            && let Some(au) = call.authority
        {
            headers.append("host", au).map_err(js)?;
        }
        let init = web_sys::RequestInit::new();
        init.set_method(call.method);
        init.set_headers(&headers);
        if !matches!(call.method, "GET" | "HEAD")
            && let Some(b) = &call.body
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
}
