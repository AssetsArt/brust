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
