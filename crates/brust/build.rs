extern crate napi_build;

use std::fs;
use std::path::PathBuf;

fn main() {
    napi_build::setup();
    compile_routes();
}

/// A2.0 — compile `src/compiled_routes/*.tsx` via `jsx_rust_compiler::compile_with_path`,
/// write emitted Rust to `$OUT_DIR/compiled_routes/<stem>.rs`. The `lib.rs` side
/// (see `src/compiled_routes/mod.rs`) `include!`s these per-fixture sub-modules.
fn compile_routes() {
    let manifest_dir = PathBuf::from(env_var("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env_var("OUT_DIR"));

    let routes_dir = manifest_dir.join("src/compiled_routes");
    if !routes_dir.exists() {
        // No .tsx fixtures yet — nothing to do, build script is forward-compatible.
        return;
    }

    let out_routes_dir = out_dir.join("compiled_routes");
    fs::create_dir_all(&out_routes_dir).expect("create OUT_DIR/compiled_routes");

    // Re-run if any .tsx changes or a new file appears.
    println!("cargo:rerun-if-changed={}", routes_dir.display());

    for entry in fs::read_dir(&routes_dir).expect("read compiled_routes dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("tsx") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .expect("UTF-8 stem");

        // Per-file rerun trigger.
        println!("cargo:rerun-if-changed={}", path.display());

        let source =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        let emitted = jsx_rust_compiler::compile_with_path(&source, &path.to_string_lossy())
            .unwrap_or_else(|e| panic!("compile {}: {}", path.display(), e));

        let out_path = out_routes_dir.join(format!("{stem}.rs"));
        fs::write(&out_path, emitted)
            .unwrap_or_else(|e| panic!("write {}: {}", out_path.display(), e));
    }
}

fn env_var(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing env var {name}"))
}
