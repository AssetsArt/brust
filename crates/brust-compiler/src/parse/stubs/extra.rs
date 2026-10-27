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

// bun_core::strings::locale_compare goes through these (ICU's "en" collator in Bun). The React Compiler sorts the
// specifiers it imports with it. ICU is not linked here, so this is an approximation of CLDR root order that agrees
// with it on ASCII names: spaces and punctuation before digits before letters, letters without regard to case first,
// then lowercase before uppercase. `is_numeric_and_base` compares a run of digits as its number and ignores case.
fn collate(
    a: impl Iterator<Item = char>,
    b: impl Iterator<Item = char>,
    numeric_and_base: bool,
) -> i32 {
    fn class(c: char) -> u8 {
        match c {
            c if c.is_whitespace() || c.is_ascii_punctuation() => 0,
            c if c.is_ascii_digit() => 1,
            c if c.is_alphabetic() => 2,
            _ => 3,
        }
    }
    fn primary(c: char) -> (u8, char) {
        (class(c), c.to_lowercase().next().unwrap_or(c))
    }
    let (a, b): (Vec<char>, Vec<char>) = (a.collect(), b.collect());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if numeric_and_base && a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let run =
                |s: &[char], k: usize| k + s[k..].iter().take_while(|c| c.is_ascii_digit()).count();
            let (ei, ej) = (run(&a, i), run(&b, j));
            let trim =
                |s: &[char]| -> Vec<char> { s.iter().copied().skip_while(|&c| c == '0').collect() };
            let (x, y) = (trim(&a[i..ei]), trim(&b[j..ej]));
            let order = x.len().cmp(&y.len()).then_with(|| x.cmp(&y));
            if order.is_ne() {
                return order as i32;
            }
            (i, j) = (ei, ej);
            continue;
        }
        let order = primary(a[i]).cmp(&primary(b[j]));
        if order.is_ne() {
            return order as i32;
        }
        (i, j) = (i + 1, j + 1);
    }
    let order = (a.len() - i).cmp(&(b.len() - j));
    if order.is_ne() || numeric_and_base {
        return order as i32;
    }
    // Tertiary: lowercase before uppercase at the first difference in case.
    for (x, y) in a.iter().zip(b.iter()) {
        if x != y {
            return (x.is_uppercase() as i32) - (y.is_uppercase() as i32);
        }
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__collateUTF8(
    is_numeric_and_base: bool,
    a: *const u8,
    a_len: usize,
    b: *const u8,
    b_len: usize,
) -> i32 {
    // SAFETY: the caller passes two live slices, as pointers and lengths.
    let (a, b) = unsafe {
        (
            core::slice::from_raw_parts(a, a_len),
            core::slice::from_raw_parts(b, b_len),
        )
    };
    collate(
        String::from_utf8_lossy(a).chars(),
        String::from_utf8_lossy(b).chars(),
        is_numeric_and_base,
    )
}

#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__collateUTF16(
    is_numeric_and_base: bool,
    a: *const u16,
    a_len: usize,
    b: *const u16,
    b_len: usize,
) -> i32 {
    // SAFETY: the caller passes two live slices, as pointers and lengths.
    let (a, b) = unsafe {
        (
            core::slice::from_raw_parts(a, a_len),
            core::slice::from_raw_parts(b, b_len),
        )
    };
    let chars = |s: &[u16]| {
        char::decode_utf16(s.iter().copied())
            .map(|c| c.unwrap_or('\u{FFFD}'))
            .collect::<Vec<_>>()
    };
    collate(
        chars(a).into_iter(),
        chars(b).into_iter(),
        is_numeric_and_base,
    )
}

#[cfg(test)]
mod tests {
    fn cmp(a: &str, b: &str, numeric: bool) -> i32 {
        super::collate(a.chars(), b.chars(), numeric)
    }

    #[test]
    fn collation_stand_in_orders_like_cldr_root_on_ascii() {
        for (a, b) in [
            ("_c", "c"),
            ("a", "B"),
            ("b", "B"),
            ("react", "react/compiler-runtime"),
            ("a-b", "a1"),
            ("a1", "ab"),
        ] {
            assert_eq!(cmp(a, b, false), -1, "{a} < {b}");
            assert_eq!(cmp(b, a, false), 1, "{b} > {a}");
        }
        assert_eq!(cmp("same", "same", false), 0);
        assert_eq!(cmp("a10", "a2", false), -1);
        assert_eq!(cmp("a2", "a10", true), -1);
        assert_eq!(cmp("A2", "a02", true), 0);
    }
}
