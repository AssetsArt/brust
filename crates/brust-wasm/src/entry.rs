//! SPIKE (Task 2).
use worker::*;

use crate::bridge::{CONFIG, MANIFEST, TEMPLATES, js_loader};

#[event(start)]
fn start() {
    crate::bridge::install();
}

#[event(fetch)]
async fn fetch(_req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    let config: String = CONFIG.with(|c| c.into());
    let _m: String = MANIFEST.with(|c| c.into());
    let keys: Vec<String> = TEMPLATES.with(|t| {
        js_sys::Object::keys(t)
            .iter()
            .filter_map(|k| k.as_string())
            .collect()
    });
    let p = js_loader("{}").map_err(|e| Error::JsError(format!("{e:?}")))?;
    let l = wasm_bindgen_futures::JsFuture::from(p)
        .await
        .map_err(|e| Error::JsError(format!("{e:?}")))?;
    Response::ok(format!(
        "{config}|{}|{}",
        keys.join(","),
        l.as_string().unwrap_or_default()
    ))
}
