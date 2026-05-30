//! napi binding for the JSX→jinja compiler (the `jsx-rust-compiler` crate).
//!
//! Lets the CLI compile `native: true` routes through the already-shipped
//! `.node` addon, so a published npm install needs no separate `jsx-rustc`
//! binary on disk (which only exists in the source tree's target/ dir). The
//! standalone `jsx-rustc` bin stays for the golden harness and source builds.
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Result of compiling one `pages/<Name>.tsx` source.
#[napi(object)]
pub struct NapiCompiledJsx {
    /// The emitted jinja template.
    pub template: String,
    /// Island manifest as JSON (`"[]"` when the route uses no `<Island>`). The
    /// camelCase keys match `RawIslandEntry` in native-routes-emit.ts.
    pub islands_json: String,
}

/// Compile a single native-route source to its jinja template + island
/// manifest. `path` is used only in error messages. Mirrors `jsx-rustc`'s
/// `compile_full` + `islands_to_json` so the TS emit step can write the same
/// `<Name>.jinja` and `<Name>.islands.json` files.
#[napi]
pub fn compile_jsx(source: String, path: String) -> Result<NapiCompiledJsx> {
    match jsx_rust_compiler::compile_full(&source, &path) {
        Ok(compiled) => Ok(NapiCompiledJsx {
            template: compiled.template,
            islands_json: jsx_rust_compiler::islands_to_json(&compiled.islands),
        }),
        Err(e) => Err(Error::from_reason(format!("{e}"))),
    }
}
