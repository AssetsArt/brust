//! A2.0 — compiled routes.
//!
//! Each `.tsx` file under `crates/brust/src/compiled_routes/` is compiled at
//! build time by `build.rs` (via `jsx_rust_compiler::compile_with_path`) into
//! `$OUT_DIR/compiled_routes/<stem>.rs`. This module mounts each emitted file
//! as a private sub-module exposing `pub struct Props` + `pub fn render(...)`.
//!
//! A2.0 ships ONE fixture (`static_hello`); A2.1 adds the napi bridge that
//! turns these `render()` calls into actual HTTP responses.

// A2.0 — the generated render() / Props are pre-wired for A2.1 (napi bridge).
// Until that lands, only the test inside this module consumes them; silence
// the dead_code noise rather than burying the signal under per-symbol allows.
#[allow(dead_code)]
pub mod static_hello {
    include!(concat!(env!("OUT_DIR"), "/compiled_routes/static_hello.rs"));
}

#[cfg(test)]
mod tests {
    use super::static_hello;

    #[test]
    fn compiled_static_hello_renders_expected_html() {
        let props = static_hello::Props {};
        let html = static_hello::render(&props).into_string();
        assert_eq!(
            html,
            "<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>"
        );
    }
}
