//! `real-mimalloc` → `--cfg bun_sema_mimalloc`: the switch `src/parse/stubs/native.rs`
//! (a verbatim Bun file) uses to drop its fake `mi_*` so the real mimalloc links.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(bun_sema_mimalloc)");
    if std::env::var_os("CARGO_FEATURE_REAL_MIMALLOC").is_some() {
        println!("cargo::rustc-cfg=bun_sema_mimalloc");
    }
    println!("cargo::rerun-if-changed=build.rs");
}
