//! `http::Response<Bytes>` → a web `Response`.
use bytes::Bytes;
use wasm_bindgen::JsValue;

use brust_core::body::is_framing_header;

fn init(parts: &http::response::Parts) -> Result<web_sys::ResponseInit, JsValue> {
    let headers = web_sys::Headers::new()?;
    // One append per value: repeated `set-cookie` survive.
    for (n, v) in &parts.headers {
        if is_framing_header(n.as_str()) {
            continue;
        }
        headers.append(n.as_str(), &String::from_utf8_lossy(v.as_bytes()))?;
    }
    let init = web_sys::ResponseInit::new();
    init.set_status(parts.status.as_u16());
    init.set_headers(&headers);
    Ok(init)
}

/// A core response (the body copied once into a `Uint8Array`; none for HEAD or an empty body).
pub fn to_web(r: http::Response<Bytes>, head: bool) -> Result<web_sys::Response, JsValue> {
    let (parts, body) = r.into_parts();
    let init = init(&parts)?;
    let buf = (!head && !body.is_empty()).then(|| js_sys::Uint8Array::from(&body[..]));
    web_sys::Response::new_with_opt_buffer_source_and_init(buf.as_ref().map(|b| b.as_ref()), &init)
}

/// An action's answer: the app's body stream untouched (null for HEAD) under the finished status
/// and headers.
pub fn rewrap(
    js: web_sys::Response,
    parts: &http::response::Parts,
    head: bool,
) -> Result<web_sys::Response, JsValue> {
    let body = if head { None } else { js.body() };
    web_sys::Response::new_with_opt_readable_stream_and_init(body.as_ref(), &init(parts)?)
}
