//! SPIKE (Task 2): the `brust-app.js` contract imports.
use wasm_bindgen::prelude::*;

#[wasm_bindgen(raw_module = "cloudflare:brust-app")]
extern "C" {
    #[wasm_bindgen(thread_local_v2, js_name = MANIFEST)]
    pub static MANIFEST: js_sys::JsString;
    #[wasm_bindgen(thread_local_v2, js_name = CONFIG)]
    pub static CONFIG: js_sys::JsString;
    #[wasm_bindgen(thread_local_v2, js_name = TEMPLATES)]
    pub static TEMPLATES: js_sys::Object;
    #[wasm_bindgen(catch, js_name = loader)]
    pub fn js_loader(json: &str) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(js_name = install)]
    pub fn js_install(rt: &JsValue);
}

pub fn invalidate(_args: JsValue) -> JsValue {
    let o = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&o, &"l1Removed".into(), &0.into());
    let _ = js_sys::Reflect::set(&o, &"jobRemoved".into(), &0.into());
    o.into()
}

/// R2a: hand the app `{ invalidate }` once at startup.
pub fn install() {
    let rt = js_sys::Object::new();
    let f = Closure::<dyn Fn(JsValue) -> JsValue>::new(invalidate).into_js_value();
    let _ = js_sys::Reflect::set(&rt, &"invalidate".into(), &f);
    js_install(&rt);
}
