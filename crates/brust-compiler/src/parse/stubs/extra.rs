//! Symbols the full parse/visit path needs beyond sema's `native.rs`: JSC-backed
//! helpers, the transpiler-cache dispatch, macros, URL. Spike-grade but exact ABI.
#[cfg(target_os = "linux")]
use core::ffi::c_int;
use core::ffi::c_void;

#[unsafe(no_mangle)]
extern "C" fn Bun__JSC__operationMathPow(x: f64, y: f64) -> f64 {
    x.powf(y)
}

#[unsafe(no_mangle)]
unsafe extern "C" fn JSC__jsToNumber(ptr: *const u8, len: usize) -> f64 {
    // SAFETY: caller passes a readable (ptr, len) range.
    let s = core::str::from_utf8(unsafe { core::slice::from_raw_parts(ptr, len) })
        .unwrap_or("")
        .trim();
    if s.is_empty() {
        0.0
    } else {
        s.parse::<f64>().unwrap_or(f64::NAN)
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__WTFStringImpl__destroy(_this: *const c_void) {}

#[unsafe(no_mangle)]
extern "C" fn URL__getFileURLString(_input: &bun_core::string::String) -> bun_core::string::String {
    bun_core::string::String::EMPTY
}

// The signature is fixed by the extern declaration in bun_js_parser.
#[allow(clippy::too_many_arguments)]
#[unsafe(no_mangle)]
pub extern "Rust" fn __bun_macro_context_call(
    _ctx: &mut bun_js_parser::Macro::MacroContext,
    _import_record_path: &[u8],
    _source_dir: &[u8],
    _log: &mut bun_ast::Log,
    _source: &bun_ast::Source,
    _import_range: bun_ast::Range,
    _caller: bun_ast::Expr,
    _function_name: &[u8],
) -> Result<bun_ast::Expr, bun_js_parser::Error> {
    unreachable!("macros are disabled (features.no_macros = true)")
}

bun_ast::link_impl_TranspilerCacheImpl! {
    Jsc for extern bun_ast::RuntimeTranspilerCache => |this| {
        get(source, parser_options, used_jsx) => { let _ = (this, source, parser_options, used_jsx); false },
        put(output_code, sourcemap, esm_record) => { let _ = (this, output_code, sourcemap, esm_record); },
        is_disabled() => { let _ = this; true },
    }
}

// Linux-only: bun_core::perf probes tracefs through these. "Unavailable" is the correct answer here.
#[cfg(target_os = "linux")]
#[unsafe(no_mangle)]
extern "C" fn Bun__linux_trace_init() -> c_int {
    0
}

#[cfg(target_os = "linux")]
#[unsafe(no_mangle)]
extern "C" fn Bun__linux_trace_close() {}

#[cfg(target_os = "linux")]
#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__linux_trace_emit(
    _event_name: *const core::ffi::c_char,
    _duration_ns: i64,
) -> c_int {
    0
}
