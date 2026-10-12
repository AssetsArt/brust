//! The `brust-app.js` contract v1 (spec §4; lanes 3/4, rulings 19753649 and D1-D3):
//!
//! | Name | Shape |
//! |---|---|
//! | module | `./brust-app.js` beside the glue (`worker/index.js`); built here as the sentinel `cloudflare:brust-app`, whose import specifiers `scripts/build.ts` rewrites |
//! | `loader`, `jobs` | `(json: string) => Promise<string>`, never reject (an error resolves `{"error": …}`) |
//! | `action` | `(req: Request) => Promise<Response>` |
//! | `MANIFEST` | `string`, `manifest.json`'s text |
//! | `TEMPLATES` | `Record<string, string>` keyed by `components[id].template` |
//! | `CONFIG` | `string`, JSON (`config.rs`) |
//! | `install` | `(rt: { invalidate }) => void`, called once by `#[event(start)]`; the app must not call `rt` at module top level |
//!
//! `rt.invalidate(args)` takes `{key?, tags?, path?, method?}` and returns `{l1Removed, jobRemoved}`;
//! bad args throw a `TypeError`. workerd normalises `..` and `\` in the URL before brust sees it,
//! so the actions `ambiguous_path` check never fires on Workers (accepted delta).
use std::collections::BTreeMap;

use brust_core::config::InvalidateArgs;
use brust_core::core::Core;
use wasm_bindgen::prelude::*;

use crate::host::WasmHost;

#[wasm_bindgen(raw_module = "cloudflare:brust-app")]
extern "C" {
    #[wasm_bindgen(thread_local_v2, js_name = MANIFEST)]
    static MANIFEST: js_sys::JsString;
    #[wasm_bindgen(thread_local_v2, js_name = CONFIG)]
    static CONFIG: js_sys::JsString;
    #[wasm_bindgen(thread_local_v2, js_name = TEMPLATES)]
    static TEMPLATES: js_sys::Object;
    #[wasm_bindgen(catch, js_name = loader)]
    pub fn js_loader(json: &str) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = jobs)]
    pub fn js_jobs(json: &str) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = action)]
    pub fn js_action(req: &web_sys::Request) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = install)]
    fn js_install(rt: &JsValue) -> Result<(), JsValue>;
}

pub fn manifest() -> String {
    MANIFEST.with(|s| String::from(s))
}

pub fn config() -> String {
    CONFIG.with(|s| String::from(s))
}

/// `TEMPLATES` as `rel path → source`; a non-string value is skipped (and then missing).
pub fn templates() -> BTreeMap<String, String> {
    TEMPLATES.with(|t| {
        js_sys::Object::entries(t)
            .iter()
            .filter_map(|e| {
                let e: js_sys::Array = e.unchecked_into();
                Some((e.get(0).as_string()?, e.get(1).as_string()?))
            })
            .collect()
    })
}

/// Hand the app `{ invalidate }` (R2a). The closure lives for the isolate.
pub fn install(core: &'static Core<WasmHost>) -> Result<(), String> {
    // A panic inside unwinds to the JS caller (the action rejects → its 500); the core is
    // per-isolate state the next request reads afresh.
    let core = std::panic::AssertUnwindSafe(core);
    let f = Closure::<dyn Fn(JsValue) -> Result<JsValue, JsValue>>::new(move |args: JsValue| {
        // `&core` moves the whole wrapper in (a bare `core.0` would capture the field alone).
        let core = &core;
        invalidate(core.0, args)
    })
    .into_js_value();
    let rt = js_sys::Object::new();
    js_sys::Reflect::set(&rt, &"invalidate".into(), &f).map_err(js_string)?;
    js_install(&rt).map_err(|e| format!("install: {}", js_string(e)))
}

fn invalidate(core: &Core<WasmHost>, args: JsValue) -> Result<JsValue, JsValue> {
    let type_error = |m: String| JsValue::from(js_sys::TypeError::new(&m));
    let json = js_sys::JSON::stringify(&args)
        .map(String::from)
        .map_err(|_| type_error("cache.invalidate: args are not JSON".into()))?;
    let args: InvalidateArgs =
        serde_json::from_str(&json).map_err(|e| type_error(format!("cache.invalidate: {e}")))?;
    let r = core.invalidate(args);
    let o = js_sys::Object::new();
    js_sys::Reflect::set(&o, &"l1Removed".into(), &(r.l1_removed as f64).into())?;
    js_sys::Reflect::set(&o, &"jobRemoved".into(), &(r.job_removed as f64).into())?;
    Ok(o.into())
}

/// A thrown JS value as text.
pub fn js_string(e: JsValue) -> String {
    e.as_string()
        .or_else(|| {
            e.dyn_ref::<js_sys::Error>()
                .map(|e| String::from(e.to_string()))
        })
        .unwrap_or_else(|| format!("{e:?}"))
}
