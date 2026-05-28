//! A2.0 — compiled routes.
//!
//! Each `.tsx` file under `crates/brust/src/compiled_routes/` is compiled at
//! build time by `build.rs` (via `jsx_rust_compiler::compile_with_path`) into
//! `$OUT_DIR/compiled_routes/<stem>.rs`. This module mounts each emitted file
//! as a private sub-module exposing `pub struct Props` + `pub fn render(...)`.
//!
//! A2.0 ships ONE fixture (`static_hello`); A2.1 adds the napi bridge that
//! turns these `render()` calls into actual HTTP responses.

pub mod static_hello {
    include!(concat!(env!("OUT_DIR"), "/compiled_routes/static_hello.rs"));
}

/// A2.3 — Component-name → render dispatch. Key is the JSX component
/// function's identity (`Component.name` from the JS side, which is the
/// PascalCase identifier the .tsx file `export default`s). `data_json` is
/// the loader-produced data shape (currently unused for prop-less
/// fixtures); A2.x will deserialize it into the fixture's `Props` struct.
///
/// Returns `Some(html)` on hit, `None` on unknown name (caller maps to 500
/// since validation should have caught registry-vs-fixture drift at config
/// time).
pub fn render_by_name(name: &str, _data_json: &str) -> Option<String> {
    match name {
        "StaticHello" => {
            let props = static_hello::Props {};
            Some(static_hello::render(&props).into_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_STATIC_HELLO: &str =
        "<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>";

    #[test]
    fn compiled_static_hello_renders_expected_html() {
        let props = static_hello::Props {};
        let html = static_hello::render(&props).into_string();
        assert_eq!(html, EXPECTED_STATIC_HELLO);
    }

    #[test]
    fn render_by_name_static_hello_hit() {
        assert_eq!(
            render_by_name("StaticHello", "{}"),
            Some(EXPECTED_STATIC_HELLO.to_string())
        );
    }

    #[test]
    fn render_by_name_unknown_returns_none() {
        assert!(render_by_name("nope", "{}").is_none());
    }
}
