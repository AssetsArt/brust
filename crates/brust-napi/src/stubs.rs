//! Link stubs for symbols the vendored Bun crates declare but only `bun_runtime` defines.
//!
//! A test executable drops the unreachable callers at link time, so `brust-compiler` gets away
//! without this stub; the cdylib keeps them, and glibc's loader resolves every undefined symbol
//! when Bun `dlopen`s the addon (`undefined symbol: __bun_run_file_poll`, CI server job on Linux).
//! The parser never runs a file poll, so reaching this is a bug: abort loudly.

/// `bun_io::posix_event_loop` declares `fn __bun_run_file_poll(poll: *mut FilePoll, size_or_offset: i64)`.
#[unsafe(no_mangle)]
pub extern "Rust" fn __bun_run_file_poll(_poll: *mut core::ffi::c_void, _size_or_offset: i64) {
    eprintln!(
        "brust-napi: __bun_run_file_poll reached (Bun event loop is not linked into the addon)"
    );
    std::process::abort();
}

/// What `bun_core` (bun-v1.4.4) declares for Bun's C++ side (ICU, WTF) that the parser, printer and
/// React Compiler never call: `String.prototype.normalize`, `Date` parsing and `Number.prototype.toFixed`
/// and friends. Same reason as above: the cdylib keeps their callers, so glibc needs a definition.
fn not_linked(name: &str) -> ! {
    eprintln!("brust-napi: {name} reached (Bun's C++ side is not linked into the addon)");
    std::process::abort();
}

#[unsafe(no_mangle)]
pub extern "C" fn Bun__normalizeUTF16(
    _form: u8,
    _text: *const u16,
    _len: usize,
    _out: *mut u16,
    _capacity: usize,
) -> i32 {
    not_linked("Bun__normalizeUTF16")
}

#[unsafe(no_mangle)]
pub extern "C" fn Bun__parseDateTimeString(_bytes: *const u8, _length: usize) -> f64 {
    not_linked("Bun__parseDateTimeString")
}

#[unsafe(no_mangle)]
pub extern "C" fn WTF__numberToFixed(
    _buf: &mut [u8; 124],
    _number: f64,
    _digits: core::ffi::c_uint,
) -> usize {
    not_linked("WTF__numberToFixed")
}

#[unsafe(no_mangle)]
pub extern "C" fn WTF__numberToPrecision(
    _buf: &mut [u8; 124],
    _number: f64,
    _precision: core::ffi::c_uint,
) -> usize {
    not_linked("WTF__numberToPrecision")
}

#[unsafe(no_mangle)]
pub extern "C" fn WTF__numberToExponential(
    _buf: &mut [u8; 124],
    _number: f64,
    _digits: core::ffi::c_int,
) -> usize {
    not_linked("WTF__numberToExponential")
}
