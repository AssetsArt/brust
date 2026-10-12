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
//! | `install` | `(rt: { invalidate, l2Count }) => { cache } \| void`, called once by `#[event(start)]`; the app must not call `rt` at module top level. `cache` (cache adapters R11/R14) = `{ get, set, since?, origin }` or `null`/absent |
//!
//! `rt.invalidate(args)` takes `{key?, tags?, path?, method?}` and returns `{l1Removed, jobRemoved}`;
//! bad args throw a `TypeError`. workerd normalises `..` and `\` in the URL before brust sees it,
//! so the actions `ambiguous_path` check never fires on Workers (accepted delta).
use std::collections::BTreeMap;

use brust_core::config::InvalidateArgs;
use brust_core::core::Core;
use wasm_bindgen::prelude::*;

use crate::host::{CacheBridge, WasmHost};

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
    fn js_install(rt: &JsValue) -> Result<JsValue, JsValue>;
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

/// Hand the app `{ invalidate, l2Count }` (R2a; cache adapters R9). The closures live for the
/// isolate. With `CONFIG.cache`, `install` must answer the adapter bridge (R14), and without it
/// must not; the bridge goes to the host.
pub fn install(core: &'static Core<WasmHost>) -> Result<(), String> {
    // A panic inside unwinds to the JS caller (the action rejects → its 500); the core is
    // per-isolate state the next request reads afresh.
    let wrapped = std::panic::AssertUnwindSafe(core);
    let f = Closure::<dyn Fn(JsValue) -> Result<JsValue, JsValue>>::new(move |args: JsValue| {
        // `&core` moves the whole wrapper in (a bare `core.0` would capture the field alone).
        let core = &wrapped;
        invalidate(core.0, args)
    })
    .into_js_value();
    let wrapped = std::panic::AssertUnwindSafe(core);
    let count = Closure::<dyn Fn(JsValue) -> bool>::new(move |name: JsValue| {
        let core = &wrapped;
        name.as_string().is_some_and(|n| core.0.l2_count(&n))
    })
    .into_js_value();
    let rt = js_sys::Object::new();
    js_sys::Reflect::set(&rt, &"invalidate".into(), &f).map_err(js_string)?;
    js_sys::Reflect::set(&rt, &"l2Count".into(), &count).map_err(js_string)?;
    let out = js_install(&rt).map_err(|e| format!("install: {}", js_string(e)))?;
    let cache = if out.is_object() {
        js_sys::Reflect::get(&out, &"cache".into()).map_err(js_string)?
    } else {
        JsValue::UNDEFINED
    };
    match (&core.l2, cache.is_object()) {
        (None, false) => Ok(()),
        (None, true) => Err("install: a cache adapter answered but CONFIG has no cache".into()),
        (Some(_), false) => {
            Err("install: CONFIG.cache is set but install returned no cache bridge".into())
        }
        (Some(l2), true) => {
            let func = |k: &str| -> Result<Option<js_sys::Function>, String> {
                let v = js_sys::Reflect::get(&cache, &k.into()).map_err(js_string)?;
                Ok(v.dyn_into::<js_sys::Function>().ok())
            };
            let (Some(get), Some(set)) = (func("get")?, func("set")?) else {
                return Err("install: the cache bridge needs get and set".into());
            };
            core.host.set_cache(CacheBridge {
                get,
                set,
                since: func("since")?,
                obj: cache,
                get_timeout: l2.get_timeout,
            });
            Ok(())
        }
    }
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
