# M1a — Foundation (workspace, Bun crate link, parse, HIR bridge, `brustc`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `v2` monorepo so that `brustc <file.tsx> --emit hir` parses a React component with Bun's own parser and prints the React Compiler's reactive scopes, with golden fixtures and CI green.

**Architecture:** A Cargo workspace links `bun_js_parser` / `bun_ast` / `bun_js_printer` as git dependencies at a pinned rev; `bun_react_compiler` is vendored as a workspace member carrying a 44-line patch that exposes `pipeline::analyze_fn`; `crates/brust-compiler` wraps parse + HIR behind two small functions and owns the native-symbol stubs; `crates/brust-compiler-cli` is `brustc`. Everything downstream (IR, lowering, runtime-dom) is later plans (M1b–M1e) built on the `Parsed` and `HirSummary` types defined here.

**Tech Stack:** Rust nightly-2026-09-15 (Bun's toolchain), Cargo git deps + `[patch]`, Bun 1.4.x (`bun` for codegen scripts and `bun check`), serde/serde_json, insta-free hand-rolled golden files.

**Spec:** `docs/design/2026-10-08-react-compiler-design.md` (§4.1, §4.2(a), §9, §10) and `docs/design/2026-10-08-bun-crate-link-spike.md`.

## Global Constraints

- Bun rev pinned: `620b50f6abea3413a30235c5885bfe8cbffd592d` (spec §10.1). Never `bun-v1.4.2` (lacks `src/sema/standalone/native.rs`).
- Toolchain: `nightly-2026-09-15`, components `rust-src`, copied from Bun's `rust-toolchain.toml` at that rev (spec §10.1).
- `BUN_CODEGEN_DIR` is set by `.cargo/config.toml` to `bun-codegen/` (relative); `SHA` in `build_options.rs` is the full 40-hex rev (spec §10.2).
- Macros stay disabled in every parse: `options.features.no_macros = true` (spec §10.2).
- React Compiler stays **disabled in the parser** (`ReactCompilerMode::Disabled`); HIR is obtained only through `analyze_fn` (spec §4.1).
- Only `crates/brust-compiler/src/parse/` and `src/analyze/` may name `bun_ast` / `bun_js_parser` / `bun_react_compiler` types in their public signatures (spec §9 rule). This plan's public types (`Parsed`, `HirSummary`) are plain Rust/serde.
- The vendored crate carries **no brust-specific logic**; the patch is visibility + `analyze_fn` only (spec §10.3).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Human-facing text in docs is English; `docs/design/*` is the source of truth, this plan argues from it.

## Review Focus

1. **A `.tsx` with a parse error** (unclosed tag) must produce a non-zero exit and the parser's message with line/column, not a panic — Task 4 pins it.
2. **A component with no `export default function`** (arrow default export, or named export only) must produce a clear `brustc` error naming the file, not `unwrap` on `None` — Task 5 pins it.
3. **A file whose default export is a function with no hooks** must still yield a `HirSummary` (zero scopes), because `static` tier components are the common case — Task 5 pins it.
4. **Two instances of `brustc` in one process / two parses in one test binary** must not corrupt each other through Bun's thread-local AST store (`ASTMemoryAllocator`) — Task 3 pins it with a test that parses two files back-to-back in one thread.
5. **`cargo build` on a machine that never ran Bun's build** must succeed from a clean clone: no reliance on `~/.cargo/git` layout, no path to the Bun checkout anywhere except the codegen script's explicit argument — Task 7 (CI) pins it on a fresh runner.

---

## File structure

```
brust/ (branch v2)
├─ Cargo.toml                                  workspace: members, [workspace.dependencies] with git pins, [workspace.lints], [patch]
├─ rust-toolchain.toml                         nightly pin
├─ rustfmt.toml                                edition 2024, max_width 100
├─ .cargo/config.toml                          [env] BUN_CODEGEN_DIR
├─ .gitignore
├─ package.json                                bun workspace root (scripts only in M1a)
├─ bun-codegen/
│  ├─ build_options.rs                         hand-written (Task 1)
│  ├─ json_byte_class.rs / xml_byte_class.rs   generated (Task 1), committed
│  └─ README.md                                what these are, how to regenerate
├─ scripts/bun-codegen.ts                      regenerates byte-class tables from a Bun checkout path
├─ vendor/bun_react_compiler/                  copy of Bun's src/react_compiler at the rev + patch (Task 3)
│  └─ BRUST-PATCH.md                           what was changed and why
├─ crates/brust-compiler/
│  ├─ Cargo.toml
│  └─ src/
│     ├─ lib.rs                                pub mod parse; pub mod analyze; pub use …
│     ├─ parse/mod.rs                          parse_tsx(path, source) -> Result<Parsed, ParseError>
│     ├─ parse/stubs/mod.rs                    mod native; mod extra;   (feature "bun-stubs", default on)
│     ├─ parse/stubs/native.rs                 verbatim copy of Bun's src/sema/standalone/native.rs
│     ├─ parse/stubs/extra.rs                  the 8 extra symbols (spike)
│     ├─ analyze/mod.rs                        pub mod hir;
│     ├─ analyze/hir.rs                        analyze_hir(&Parsed) -> Result<HirSummary, HirError>; AstHost
│     └─ summary.rs                            HirSummary / ScopeInfo (serde)
├─ crates/brust-compiler-cli/
│  ├─ Cargo.toml                               bin name "brustc"
│  └─ src/main.rs                              args: <file> --emit hir|parse ; exit codes
├─ tests/fixtures/<case>/input.tsx + expected.hir.json   (Task 6)
├─ crates/brust-compiler/tests/fixtures.rs     golden runner (Task 6)
├─ .github/workflows/ci.yml                    (Task 7)
└─ docs/design/bun-rev-bump.md                 (Task 8)
```

Interfaces that later plans build on (defined in this plan, frozen at the end of it):

```rust
// crates/brust-compiler/src/parse/mod.rs
pub struct Parsed { /* opaque: owns arena, source, ast, log */ }
pub struct ParseError { pub message: String, pub line: u32, pub column: u32 }
pub fn parse_tsx(path: &str, source: Vec<u8>) -> Result<Parsed, ParseError>;
impl Parsed {
    pub fn symbol_count(&self) -> usize;
    pub fn import_paths(&self) -> Vec<String>;
    pub fn default_export_function_name(&self) -> Option<String>;
}

// crates/brust-compiler/src/summary.rs
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct HirSummary { pub function: String, pub params: usize, pub scopes: Vec<ScopeInfo>, pub identifiers: usize }
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct ScopeInfo { pub id: u32, pub pruned: bool, pub deps: Vec<DepInfo>, pub decls: Vec<String> }
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct DepInfo { pub name: String, pub reactive: bool }

// crates/brust-compiler/src/analyze/hir.rs
pub enum HirError { NoDefaultExportFunction, Unsupported(String) }
pub fn analyze_hir(parsed: &Parsed) -> Result<HirSummary, HirError>;
```

---

### Task 1: Workspace skeleton that compiles Bun's parser crates

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml`, `.cargo/config.toml`, `.gitignore`, `package.json`
- Create: `bun-codegen/build_options.rs`, `bun-codegen/README.md`, `scripts/bun-codegen.ts`
- Create: `crates/brust-compiler/Cargo.toml`, `crates/brust-compiler/src/lib.rs` (empty lib for now)

**Interfaces:**
- Produces: a workspace where `cargo check -p brust-compiler` compiles `bun_js_parser`, `bun_ast`, `bun_js_printer` from git. Nothing else.

- [ ] **Step 1: Write the workspace manifest**

`Cargo.toml`:

```toml
[workspace]
resolver = "3"
members = ["crates/brust-compiler", "crates/brust-compiler-cli", "vendor/bun_react_compiler"]

[workspace.package]
version = "0.0.0"
edition = "2024"
license = "MIT"

# Bun crates. One rev for all of them; bump via docs/design/bun-rev-bump.md.
[workspace.dependencies]
bun_js_parser      = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_ast            = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_js_printer     = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_react_compiler = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_alloc          = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_core           = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_collections    = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_threading      = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
# Third-party versions the vendored Bun crate inherits (copied from Bun's workspace at the rev).
enumset  = "1"
smallvec = "1"
bstr     = { version = "1", default-features = false, features = ["alloc"] }
thiserror = "2"
libc     = "0.2"
serde      = { version = "1", features = ["derive"] }
serde_json = "1"

# Minimal lint tables so the vendored crate's `[lints] workspace = true` resolves.
# Copied from Bun's `[workspace.lints.rust]` entry that silences its cfg names.
[workspace.lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = ['cfg(bun_asan)', 'cfg(bun_debug)', 'cfg(socket_fault_injection)', 'cfg(bun_sema_mimalloc)'] }

[workspace.lints.clippy]

# Our patched copy replaces the git crate everywhere, including inside bun_js_parser.
[patch."https://github.com/oven-sh/bun"]
bun_react_compiler = { path = "vendor/bun_react_compiler" }

[profile.dev]
opt-level = 1          # Bun's parser is unusably slow at opt-level 0 and the build is dominated by it anyway

[profile.release]
lto = "thin"
codegen-units = 1
```

Note: the `[patch]` line and the `vendor/bun_react_compiler` member point at a directory Task 3 creates. Until then, keep both commented out (`# ` prefix) — Step 7 below says exactly when to uncomment.

- [ ] **Step 2: Toolchain, rustfmt, cargo config, gitignore, package.json**

`rust-toolchain.toml` (same channel and components Bun pins at the rev):

```toml
[toolchain]
channel = "nightly-2026-09-15"
components = ["rust-src", "rustfmt", "clippy"]
```

`rustfmt.toml`:

```toml
edition = "2024"
max_width = 100
```

`.cargo/config.toml`:

```toml
[env]
# bun_core / bun_parsers include!() generated files from here (spec §10.2).
BUN_CODEGEN_DIR = { value = "bun-codegen", relative = true }
```

`.gitignore`:

```
/target
/node_modules
*.node
.DS_Store
```

`package.json`:

```json
{
  "name": "brust-v2",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "bun-codegen": "bun scripts/bun-codegen.ts"
  }
}
```

- [ ] **Step 3: Hand-write `bun-codegen/build_options.rs`**

Exactly this content (the 16 constants Bun's `scripts/build/buildOptionsRs.ts` emits; `SHA` is the pinned rev, 40 chars — a shorter string fails `bun_core` const-eval with "mid > len"):

```rust
// Stand-in for the file Bun's `scripts/build/buildOptionsRs.ts` writes at configure
// time. `bun_core` does `include!(concat!(env!("BUN_CODEGEN_DIR"), "/build_options.rs"))`.
// Keep SHA equal to the pinned rev in Cargo.toml (40 hex chars — const-eval slices it).
#[allow(dead_code, unreachable_pub, unused)]
pub const SHA: &str = "620b50f6abea3413a30235c5885bfe8cbffd592d";
#[allow(dead_code, unreachable_pub, unused)]
pub const REPORTED_NODEJS_VERSION: &str = "v24.3.0";
#[allow(dead_code, unreachable_pub, unused)]
pub const RELEASE_SAFE: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const IS_CANARY: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const CANARY_REVISION: &str = "0";
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_FUZZILLI: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const FALLBACK_HTML_VERSION: &str = "0000000000000000";
#[allow(dead_code, unreachable_pub, unused)]
pub const VERSION: crate::Version = crate::Version { major: 1, minor: 4, patch: 2 };
#[allow(dead_code, unreachable_pub, unused)]
pub const BASE_PATH: &[u8] = "/brust-v2".as_bytes();
#[allow(dead_code, unreachable_pub, unused)]
pub const CODEGEN_PATH: &[u8] = "/brust-v2/bun-codegen".as_bytes();
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_LOGS: bool = cfg!(bun_debug);
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_ASAN: bool = cfg!(bun_asan);
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_TINYCC: bool = !cfg!(any(target_os = "android", target_os = "freebsd"));
```

- [ ] **Step 4: Write the byte-class generator script and run it**

`scripts/bun-codegen.ts` — takes the path of a Bun checkout at the pinned rev and runs Bun's own generators into `bun-codegen/`:

```ts
// Usage: bun scripts/bun-codegen.ts <path-to-bun-checkout>
// Regenerates bun-codegen/{json,xml}_byte_class.{rs,h} with Bun's own generators.
// Run only when bumping the Bun rev (docs/design/bun-rev-bump.md). Output is committed.
import { resolve } from "node:path";

const bunSrc = process.argv[2];
if (!bunSrc) {
  console.error("usage: bun scripts/bun-codegen.ts <path-to-bun-checkout>");
  process.exit(2);
}
const codegenDir = resolve(import.meta.dir, "..", "bun-codegen");
const { generateJsonByteClass } = await import(resolve(bunSrc, "scripts/build/jsonByteClass.ts"));
const { generateXmlByteClass } = await import(resolve(bunSrc, "scripts/build/xmlByteClass.ts"));
console.log(generateJsonByteClass({ codegenDir }));
console.log(generateXmlByteClass({ codegenDir }));
```

Get a checkout at the rev (sparse, fast) and run it:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/oven-sh/bun /tmp/bun-src
git -C /tmp/bun-src sparse-checkout set src/sema/standalone src/react_compiler scripts/build
git -C /tmp/bun-src rev-parse HEAD      # must print 620b50f6abea3413a30235c5885bfe8cbffd592d; if main moved, run: git -C /tmp/bun-src fetch --depth 1 origin 620b50f6abea3413a30235c5885bfe8cbffd592d && git -C /tmp/bun-src checkout 620b50f6abea3413a30235c5885bfe8cbffd592d
bun scripts/bun-codegen.ts /tmp/bun-src
ls bun-codegen
```

Expected: `build_options.rs json_byte_class.h json_byte_class.rs xml_byte_class.h xml_byte_class.rs`.

- [ ] **Step 5: `bun-codegen/README.md`**

```markdown
# bun-codegen

Files Bun's own build would generate into `build/debug/codegen`, which the Bun crates
`include!()` through `BUN_CODEGEN_DIR` (set in `.cargo/config.toml`).

- `build_options.rs` — hand-written; `SHA` must equal the pinned rev in `Cargo.toml`.
- `json_byte_class.*`, `xml_byte_class.*` — generated by `bun scripts/bun-codegen.ts <bun-checkout>`.

Regenerate only when bumping the Bun rev: see `docs/design/bun-rev-bump.md`.
```

- [ ] **Step 6: Empty compiler crate that pulls the Bun crates**

`crates/brust-compiler/Cargo.toml`:

```toml
[package]
name = "brust-compiler"
version.workspace = true
edition.workspace = true
license.workspace = true

[features]
default = ["bun-stubs"]
# Provides the native symbols Bun's C/C++ normally supplies. Disable only when linking
# into a host that already provides them.
bun-stubs = []

[dependencies]
bun_js_parser.workspace = true
bun_ast.workspace = true
bun_js_printer.workspace = true
bun_react_compiler.workspace = true
bun_alloc.workspace = true
bun_core.workspace = true
bun_threading.workspace = true
bstr.workspace = true
libc.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true

[lints]
workspace = true
```

`crates/brust-compiler/src/lib.rs`:

```rust
//! brust v2 compiler. See docs/design/2026-10-08-react-compiler-design.md.
//! Only `parse` and `analyze` may expose Bun AST types; everything else is plain Rust.
```

Also create `crates/brust-compiler-cli/Cargo.toml` + an empty `src/main.rs` now so the workspace member list is valid (Task 4 fills it):

```toml
[package]
name = "brust-compiler-cli"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "brustc"
path = "src/main.rs"

[dependencies]
brust-compiler = { path = "../brust-compiler" }
serde_json.workspace = true

[lints]
workspace = true
```

```rust
fn main() {}
```

- [ ] **Step 7: First build (with the vendor member and `[patch]` commented out)**

Edit `Cargo.toml`: comment out `"vendor/bun_react_compiler"` in `members` and the two `[patch…]` lines. Then:

```bash
time cargo check -p brust-compiler 2>&1 | tail -5
```

Expected: first run clones Bun (~1–2 min), then compiles; ends with `Finished`. If it fails with `build_options.rs not found` the `.cargo/config.toml` env is not being picked up (run from the repo root). If it fails with `json_byte_class.rs not found`, Step 4 was skipped.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml rust-toolchain.toml rustfmt.toml .cargo .gitignore package.json bun-codegen scripts crates
git commit -m "build: v2 workspace linking Bun's parser crates at 620b50f6

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Native stubs + `parse_tsx`

**Files:**
- Create: `crates/brust-compiler/src/parse/mod.rs`, `src/parse/stubs/mod.rs`, `src/parse/stubs/native.rs`, `src/parse/stubs/extra.rs`
- Modify: `crates/brust-compiler/src/lib.rs`
- Test: `crates/brust-compiler/tests/parse.rs`, fixture `tests/fixtures/theme-toggle/input.tsx` (repo root `tests/`)

**Interfaces:**
- Produces: `parse::parse_tsx(path: &str, source: Vec<u8>) -> Result<Parsed, ParseError>`; `Parsed::{symbol_count, import_paths, default_export_function_name}`; `pub(crate)` accessors `Parsed::{ast, source, arena}` for `analyze`.

- [ ] **Step 1: Create the fixture**

`tests/fixtures/theme-toggle/input.tsx`:

```tsx
import { useState, useEffect } from 'react'

export default function ThemeToggle({ themeLabel }: { themeLabel: string }) {
  const [mode, setMode] = useState('dark')
  const label = mode === 'dark' ? 'Light' : 'Dark'

  useEffect(() => {
    document.documentElement.dataset.mode = mode
  }, [mode])

  return (
    <button type="button" aria-label={themeLabel} onClick={() => setMode((m) => (m === 'dark' ? 'light' : 'dark'))}>
      {label}
    </button>
  )
}
```

- [ ] **Step 2: Write the failing tests**

`crates/brust-compiler/tests/parse.rs`:

```rust
use brust_compiler::parse::{parse_tsx, ParseError};

fn fixture(name: &str) -> (String, Vec<u8>) {
    let path = format!("{}/../../tests/fixtures/{name}/input.tsx", env!("CARGO_MANIFEST_DIR"));
    let src = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    (path, src)
}

#[test]
fn parses_theme_toggle() {
    let (path, src) = fixture("theme-toggle");
    let parsed = parse_tsx(&path, src).expect("parse ok");
    assert!(parsed.symbol_count() > 10, "symbols: {}", parsed.symbol_count());
    assert_eq!(parsed.import_paths(), vec!["react".to_string()]);
    assert_eq!(parsed.default_export_function_name().as_deref(), Some("ThemeToggle"));
}

#[test]
fn reports_syntax_error_with_position() {
    let err = parse_tsx("bad.tsx", b"export default function X() { return <div> }".to_vec())
        .err()
        .expect("must fail");
    let ParseError { message, line, column } = err;
    assert!(!message.is_empty());
    assert_eq!(line, 1);
    assert!(column > 0);
}

#[test]
fn two_parses_in_one_thread_do_not_interfere() {
    let (path, src) = fixture("theme-toggle");
    let a = parse_tsx(&path, src.clone()).unwrap();
    let b = parse_tsx(&path, src).unwrap();
    assert_eq!(a.symbol_count(), b.symbol_count());
    assert_eq!(a.default_export_function_name(), b.default_export_function_name());
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p brust-compiler --test parse 2>&1 | tail -5`
Expected: compile error `unresolved import brust_compiler::parse`.

- [ ] **Step 4: Copy Bun's `native.rs` verbatim and add the 8 extra stubs**

```bash
mkdir -p crates/brust-compiler/src/parse/stubs
cp /tmp/bun-src/src/sema/standalone/native.rs crates/brust-compiler/src/parse/stubs/native.rs
```

Add this header comment at the top of the copied file (first line), nothing else changes:

```rust
// VERBATIM COPY of oven-sh/bun src/sema/standalone/native.rs at rev 620b50f6. Do not edit; re-copy on bump.
```

`crates/brust-compiler/src/parse/stubs/extra.rs`:

```rust
//! Symbols the full parse/visit path needs beyond sema's `native.rs`: JSC-backed
//! helpers, the transpiler-cache dispatch, macros, URL. Spike-grade but exact ABI.
use core::ffi::{c_int, c_void};

#[repr(C)]
struct SimdutfResult {
    status: c_int,
    count: usize,
}

#[unsafe(no_mangle)]
unsafe extern "C" fn simdutf__convert_utf8_to_utf16le_with_errors(
    p: *const u8,
    len: usize,
    out: *mut u16,
) -> SimdutfResult {
    // SAFETY: caller passes a readable (p, len) range and an output buffer sized for it.
    let bytes = unsafe { core::slice::from_raw_parts(p, len) };
    let Ok(s) = core::str::from_utf8(bytes) else {
        return SimdutfResult { status: 1, count: 0 };
    };
    let mut n = 0usize;
    for u in s.encode_utf16() {
        // SAFETY: simdutf's contract — `out` holds at least utf16_length_from_utf8(p, len) units.
        unsafe { out.add(n).write(u) };
        n += 1;
    }
    SimdutfResult { status: 0, count: n }
}

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
    if s.is_empty() { 0.0 } else { s.parse::<f64>().unwrap_or(f64::NAN) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__WTFStringImpl__destroy(_this: *const c_void) {}

#[unsafe(no_mangle)]
extern "C" fn URL__getFileURLString(_input: &bun_core::string::String) -> bun_core::string::String {
    bun_core::string::String::EMPTY
}

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
```

`crates/brust-compiler/src/parse/stubs/mod.rs`:

```rust
//! Native symbols Bun's C/C++ side normally provides. Compiled in by default
//! (feature `bun-stubs`); a host that links the real Bun turns the feature off.
#![allow(unsafe_op_in_unsafe_fn, dead_code, non_snake_case, clippy::missing_safety_doc)]
pub(super) mod extra;
pub(super) mod native;
```

- [ ] **Step 5: Write `parse/mod.rs`**

```rust
//! Parse a `.tsx` file with Bun's parser. The only module (with `analyze`) that
//! names `bun_ast` types. Everything stays private except the plain accessors.
#[cfg(feature = "bun-stubs")]
mod stubs;

use bun_ast as js_ast;

/// A parsed module. Owns the arena every AST node lives in; drop order is
/// field order, so `ast` is dropped before `arena` (declared last).
pub struct Parsed {
    pub(crate) source: js_ast::Source,
    pub(crate) ast: js_ast::Ast<'static>,
    pub(crate) default_export_fn: Option<String>,
    pub(crate) import_paths: Vec<String>,
    // Leaked on purpose for `'static`: the parser borrows source bytes for the
    // whole Ast lifetime and brust keeps a Parsed for the duration of one compile.
    pub(crate) arena: Box<bun_alloc::Arena>,
    _ast_scope: Box<js_ast::ASTMemoryAllocator>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message} ({line}:{column})")]
pub struct ParseError {
    pub message: String,
    pub line: u32,
    pub column: u32,
}

static STACK_READY: std::sync::Once = std::sync::Once::new();

pub fn parse_tsx(path: &str, source: Vec<u8>) -> Result<Parsed, ParseError> {
    STACK_READY.call_once(|| {
        #[cfg(feature = "bun-stubs")]
        stubs::native::set_stack_size(7 << 20);
    });
    let text: &'static [u8] = Box::leak(source.into_boxed_slice());
    let path_bytes: &'static [u8] = Box::leak(path.as_bytes().to_vec().into_boxed_slice());

    let arena = Box::new(bun_alloc::Arena::new());
    // SAFETY: `arena` is boxed and stored in `Parsed`; it outlives every borrow below.
    let arena_ref: &'static bun_alloc::Arena = unsafe { &*(&*arena as *const bun_alloc::Arena) };
    let mut ast_alloc = Box::new(js_ast::ASTMemoryAllocator::borrowing(arena_ref));
    // The scope guard must be active while parsing; we keep the allocator alive in Parsed.
    let scope = ast_alloc.enter();
    core::mem::forget(scope);

    let src = js_ast::Source::init_path_string(path_bytes, text);
    let mut opts = bun_js_parser::ParserOptions::init(Default::default(), js_ast::Loader::Tsx);
    opts.features.no_macros = true;
    opts.features.react_compiler = js_ast::runtime::ReactCompilerMode::Disabled;
    let define = bun_js_parser::Define::default();
    let mut log = js_ast::Log::init();

    let parser = bun_js_parser::Parser::init(opts, &mut log, &src, &define, arena_ref)
        .map_err(|e| ParseError { message: format!("{e:?}"), line: 0, column: 0 })?;
    let result = parser.parse().map_err(|e| ParseError { message: format!("{e:?}"), line: 0, column: 0 });
    if log.errors > 0 {
        return Err(first_error(&log, text));
    }
    let bun_js_parser::Result::Ast(ast) = result? else {
        return Err(ParseError { message: "parser did not return an AST".into(), line: 0, column: 0 });
    };

    let import_paths = ast
        .import_records
        .as_slice()
        .iter()
        .map(|r| String::from_utf8_lossy(r.path.text.slice()).into_owned())
        .collect();
    let default_export_fn = find_default_export_fn(&ast);

    Ok(Parsed { source: src, ast, default_export_fn, import_paths, arena, _ast_scope: ast_alloc })
}

fn first_error(log: &js_ast::Log, text: &[u8]) -> ParseError {
    let msg = log.msgs.iter().find(|m| m.kind == js_ast::Msg::Kind::Err).or(log.msgs.first());
    match msg {
        Some(m) => {
            let (line, column) = m.data.location.as_ref().map(|l| (l.line as u32, l.column as u32)).unwrap_or_else(|| offset_to_line_col(text, 0));
            ParseError { message: String::from_utf8_lossy(m.data.text.slice()).into_owned(), line, column }
        }
        None => ParseError { message: "parse failed".into(), line: 0, column: 0 },
    }
}

fn offset_to_line_col(text: &[u8], offset: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut col = 1u32;
    for &b in &text[..offset.min(text.len())] {
        if b == b'\n' { line += 1; col = 1; } else { col += 1; }
    }
    (line, col)
}

fn find_default_export_fn(ast: &js_ast::Ast<'_>) -> Option<String> {
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let js_ast::stmt::Data::SExportDefault(ed) = &stmt.data
                && let js_ast::StmtOrExpr::Stmt(inner) = &ed.value
                && let js_ast::stmt::Data::SFunction(sf) = &inner.data
            {
                let name = sf.func.name.as_ref().map(|n| {
                    String::from_utf8_lossy(ast.symbols.as_slice()[n.ref_.inner_index() as usize].original_name.slice()).into_owned()
                });
                return name.or(Some(String::new()));
            }
        }
    }
    None
}

impl Parsed {
    pub fn symbol_count(&self) -> usize { self.ast.symbols.len() }
    pub fn import_paths(&self) -> Vec<String> { self.import_paths.clone() }
    pub fn default_export_function_name(&self) -> Option<String> { self.default_export_fn.clone() }
}
```

The exact field names of `Msg` (`m.kind`, `m.data.location.line/column`, `m.data.text`) are to be read off `bun_ast::Log`/`Msg` in the checkout (`src/ast/lib.rs` around `pub struct Log` and `pub struct Msg`); adjust the two lines in `first_error` to the real names — the test in Step 2 is the contract (line 1, column > 0).

Register in `lib.rs`:

```rust
pub mod parse;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p brust-compiler --test parse 2>&1 | tail -15`
Expected: 3 passed. If the link step reports undefined symbols, the list in `extra.rs` is incomplete for this rev: add the symbol with the signature from Bun's `extern` block (grep its name under `/tmp/bun-src/src`) and note it in `BRUST-PATCH.md` (Task 3) — do not remove any existing stub.

- [ ] **Step 7: Commit**

```bash
git add crates/brust-compiler tests/fixtures/theme-toggle
git commit -m "feat(compiler): parse_tsx over Bun's parser with native stubs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Vendored `bun_react_compiler` with the `analyze_fn` patch

**Files:**
- Create: `vendor/bun_react_compiler/**` (copy), `vendor/bun_react_compiler/BRUST-PATCH.md`
- Modify: `Cargo.toml` (uncomment member + `[patch]`), `vendor/bun_react_compiler/Cargo.toml`, `lib.rs`, `pipeline.rs`, `imports.rs`, `lowering/mod.rs`, `lowering/hir_builder.rs`, `lowering/build_hir/mod.rs`
- Test: a `cargo tree` assertion in CI (Task 7) and the compile of Task 5

**Interfaces:**
- Produces (in the vendored crate): `pub mod pipeline` with
  `pub fn analyze_fn(func: &FunctionNode<'_>, fn_name: Option<&str>, host: &mut dyn Host, fn_type: ReactFunctionType, env_config: &EnvironmentConfig, context: &mut ProgramContext, import_bindings: &IndexMap<Ref, VariableBinding>) -> Result<(ReactiveFunction, Environment), CompilerError>`;
  `pub use lowering::FunctionNode`; `pub mod imports` with `pub struct ProgramContext` + `pub fn new(opts, filename, code, has_module_scope_opt_out)` + `pub fn init_from_scope(&mut self, &[Symbol])`.

- [ ] **Step 1: Copy the crate at the rev**

```bash
mkdir -p vendor
cp -R /tmp/bun-src/src/react_compiler vendor/bun_react_compiler
rm -rf vendor/bun_react_compiler/target
```

- [ ] **Step 2: Rewrite its manifest for our workspace**

`vendor/bun_react_compiler/Cargo.toml` — change only the `bun_ast` line:

```toml
bun_ast.workspace = true
```

(everything else — `version.workspace`, `edition.workspace`, `[lints] workspace = true`, `bun_alloc.workspace`, `bun_core.workspace`, `bun_collections.workspace`, `rustc-hash = "2"`, `enumset.workspace`, `smallvec.workspace`, the `fixtures` feature — stays verbatim; our root `[workspace.dependencies]` from Task 1 provides every name).

- [ ] **Step 3: Apply the visibility patch**

```bash
cd vendor/bun_react_compiler
sed -i '' 's/^pub(crate) enum FunctionNode/pub enum FunctionNode/' lowering/hir_builder.rs
sed -i '' 's/^pub(crate) use build_hir::lower;/pub use build_hir::lower;/' lowering/mod.rs
sed -i '' 's/^pub(crate) use hir_builder::{FunctionNode, convert_loc};/pub use hir_builder::FunctionNode;\npub(crate) use hir_builder::convert_loc;/' lowering/mod.rs
sed -i '' 's/^pub(crate) fn lower(/pub fn lower(/' lowering/build_hir/mod.rs
sed -i '' 's/^pub(crate) struct ProgramContext/pub struct ProgramContext/; s/^    pub(crate) fn new($/    pub fn new(/; s/^    pub(crate) fn init_from_scope/    pub fn init_from_scope/' imports.rs
sed -i '' 's/^mod imports;/pub mod imports;/; s/^pub(crate) mod pipeline;/pub mod pipeline;/' lib.rs
cd ../..
```

- [ ] **Step 4: Append `analyze_fn` to `pipeline.rs`**

```rust

/// brust: run lowering + every HIR pass and return the reactive function together
/// with the `Environment` that owns its scopes and identifiers. Mirrors `compile_fn`
/// up to (not including) codegen. Contains no brust-specific logic.
pub fn analyze_fn(
    func: &FunctionNode<'_>,
    fn_name: Option<&str>,
    host: &mut dyn Host,
    fn_type: ReactFunctionType,
    env_config: &EnvironmentConfig,
    context: &mut ProgramContext,
    import_bindings: &IndexMap<bun_ast::Ref, VariableBinding>,
) -> Result<(crate::hir::reactive::ReactiveFunction, Environment), CompilerError> {
    let mut env = Environment::with_config(env_config.clone());
    env.fn_type = fn_type;
    env.output_mode = context.output_mode;
    let known: HashSet<StoreStr> = context
        .known_referenced_names()
        .iter()
        .map(|s| StoreStr::new(s.as_bytes()))
        .collect();
    env.seed_uid_known_names(&known);
    let mut hir = lowering::lower(func, fn_name, &*host, &mut env, import_bindings)?;
    if env.has_errors() {
        return Err(env.take_errors());
    }
    let (reactive_fn, _uids) = run_hir_passes(&mut hir, &mut env, context)?;
    Ok((reactive_fn, env))
}
```

- [ ] **Step 5: Record the patch**

`vendor/bun_react_compiler/BRUST-PATCH.md`:

```markdown
# brust patch over oven-sh/bun src/react_compiler @ 620b50f6abea3413a30235c5885bfe8cbffd592d

Purpose: let an external crate run lowering + HIR passes and read the reactive
function and scopes without codegen (spec §10.3). No brust logic lives here.

Changes (re-apply on every rev bump; see docs/design/bun-rev-bump.md):
1. Cargo.toml: `bun_ast = { path = "../ast" }` → `bun_ast.workspace = true`
2. lib.rs: `mod imports;` → `pub mod imports;`, `pub(crate) mod pipeline;` → `pub mod pipeline;`
3. imports.rs: `ProgramContext`, `ProgramContext::new`, `init_from_scope` → `pub`
4. lowering/mod.rs: re-export `FunctionNode` and `lower` as `pub`
5. lowering/hir_builder.rs: `enum FunctionNode` → `pub`
6. lowering/build_hir/mod.rs: `fn lower` → `pub`
7. pipeline.rs: append `pub fn analyze_fn(...)` (see end of file)

Verify with: `cargo tree -p bun_js_parser -i bun_react_compiler` → must show this path.
```

- [ ] **Step 6: Enable the member and the `[patch]`, build, verify the patch took effect**

Uncomment in `Cargo.toml` the `"vendor/bun_react_compiler"` member and the two `[patch…]` lines. Then:

```bash
cargo build -p brust-compiler 2>&1 | tail -3
cargo tree -p brust-compiler -i bun_react_compiler 2>&1 | head -5
```

Expected: `Finished`; the tree shows `bun_react_compiler v0.0.0 (…/vendor/bun_react_compiler)` — a **path**, not a git URL — and only one `bun_react_compiler` node. If two copies appear (one git, one path), the `[patch]` did not apply to the path dependency inside `bun_js_parser`; escalate to the lead with the `cargo tree` output (the fallback is to switch every `bun_*` entry in `[workspace.dependencies]` to path deps into a vendored full checkout, which is a plan change).

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml vendor
git commit -m "build(vendor): bun_react_compiler @620b50f6 with analyze_fn patch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `brustc` with `--emit parse`

**Files:**
- Modify: `crates/brust-compiler-cli/src/main.rs`
- Test: `crates/brust-compiler-cli/tests/cli.rs`

**Interfaces:**
- Produces: `brustc <file.tsx> --emit parse` prints JSON `{ "file", "symbols", "imports", "default_export_function" }`; exit 0; exit 1 on parse error with `error: <message> (<file>:<line>:<col>)` on stderr; exit 2 on bad usage.

- [ ] **Step 1: Write the failing tests**

`crates/brust-compiler-cli/tests/cli.rs`:

```rust
use std::process::Command;

fn brustc() -> Command { Command::new(env!("CARGO_BIN_EXE_brustc")) }
fn fixture(name: &str) -> String { format!("{}/../../tests/fixtures/{name}/input.tsx", env!("CARGO_MANIFEST_DIR")) }

#[test]
fn emit_parse_prints_json() {
    let out = brustc().arg(fixture("theme-toggle")).args(["--emit", "parse"]).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["default_export_function"], "ThemeToggle");
    assert_eq!(v["imports"], serde_json::json!(["react"]));
}

#[test]
fn parse_error_exits_1_with_position() {
    let dir = std::env::temp_dir().join("brustc-bad");
    std::fs::create_dir_all(&dir).unwrap();
    let bad = dir.join("bad.tsx");
    std::fs::write(&bad, "export default function X() { return <div> }").unwrap();
    let out = brustc().arg(&bad).args(["--emit", "parse"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.starts_with("error: "), "{err}");
    assert!(err.contains("bad.tsx:1:"), "{err}");
}

#[test]
fn bad_usage_exits_2() {
    let out = brustc().output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p brust-compiler-cli --test cli 2>&1 | tail -5`
Expected: all three fail (binary exits 0 with no output).

- [ ] **Step 3: Implement `main.rs`**

```rust
//! brustc — the v2 compiler CLI. M1a: `--emit parse|hir`.
use std::process::ExitCode;

const USAGE: &str = "usage: brustc <file.tsx> --emit parse|hir";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (file, emit) = match parse_args(&args) {
        Some(x) => x,
        None => { eprintln!("{USAGE}"); return ExitCode::from(2); }
    };
    let source = match std::fs::read(&file) {
        Ok(s) => s,
        Err(e) => { eprintln!("error: cannot read {file}: {e}"); return ExitCode::from(1); }
    };
    let parsed = match brust_compiler::parse::parse_tsx(&file, source) {
        Ok(p) => p,
        Err(e) => { eprintln!("error: {} ({file}:{}:{})", e.message, e.line, e.column); return ExitCode::from(1); }
    };
    match emit.as_str() {
        "parse" => {
            let v = serde_json::json!({
                "file": file,
                "symbols": parsed.symbol_count(),
                "imports": parsed.import_paths(),
                "default_export_function": parsed.default_export_function_name(),
            });
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
            ExitCode::SUCCESS
        }
        "hir" => match brust_compiler::analyze::hir::analyze_hir(&parsed) {
            Ok(summary) => { println!("{}", serde_json::to_string_pretty(&summary).unwrap()); ExitCode::SUCCESS }
            Err(e) => { eprintln!("error: {e} ({file})"); ExitCode::from(1) }
        },
        other => { eprintln!("error: unknown --emit {other}\n{USAGE}"); ExitCode::from(2) }
    }
}

fn parse_args(args: &[String]) -> Option<(String, String)> {
    let mut file = None;
    let mut emit = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--emit" => { emit = args.get(i + 1).cloned(); i += 2; }
            a if a.starts_with("--") => return None,
            a => { file = Some(a.to_string()); i += 1; }
        }
    }
    Some((file?, emit?))
}
```

The `"hir"` arm references `analyze::hir::analyze_hir` from Task 5; until Task 5 lands, add a temporary module `crates/brust-compiler/src/analyze/mod.rs` containing only `pub mod hir;` and `hir.rs` with:

```rust
use crate::parse::Parsed;
#[derive(Debug, thiserror::Error)]
pub enum HirError {
    #[error("no `export default function` in this module")]
    NoDefaultExportFunction,
    #[error("react compiler could not lower this component: {0}")]
    Unsupported(String),
}
pub fn analyze_hir(_parsed: &Parsed) -> Result<crate::summary::HirSummary, HirError> { Err(HirError::Unsupported("not implemented".into())) }
```

plus `crates/brust-compiler/src/summary.rs` with the `HirSummary`/`ScopeInfo`/`DepInfo` types exactly as in the "Interfaces" block at the top of this plan, and `pub mod analyze; pub mod summary;` in `lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p brust-compiler-cli --test cli 2>&1 | tail -8`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add crates
git commit -m "feat(brustc): --emit parse with positioned errors and exit codes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: HIR bridge — `analyze_hir` and the `AstHost`

**Files:**
- Modify: `crates/brust-compiler/src/analyze/hir.rs` (replace the stub), `src/parse/mod.rs` (add `pub(crate)` accessors), `src/summary.rs` (unchanged types)
- Test: `crates/brust-compiler/tests/hir.rs`, fixtures `tests/fixtures/static-text/input.tsx`, `tests/fixtures/arrow-default/input.tsx`

**Interfaces:**
- Consumes: `Parsed { ast, source, arena }` (pub(crate)), vendored `analyze_fn`.
- Produces: `analyze_hir(&Parsed) -> Result<HirSummary, HirError>` with scopes sorted by id and dep names resolved through the HIR `Environment`.

- [ ] **Step 1: Create fixtures**

`tests/fixtures/static-text/input.tsx`:

```tsx
export default function Hello({ name }: { name: string }) {
  return <p className="greet">Hello, {name}!</p>
}
```

`tests/fixtures/arrow-default/input.tsx`:

```tsx
const Hello = ({ name }: { name: string }) => <p>{name}</p>
export default Hello
```

- [ ] **Step 2: Write the failing tests**

`crates/brust-compiler/tests/hir.rs`:

```rust
use brust_compiler::analyze::hir::{analyze_hir, HirError};
use brust_compiler::parse::parse_tsx;

fn parsed(name: &str) -> brust_compiler::parse::Parsed {
    let path = format!("{}/../../tests/fixtures/{name}/input.tsx", env!("CARGO_MANIFEST_DIR"));
    parse_tsx(&path, std::fs::read(&path).unwrap()).unwrap()
}

#[test]
fn theme_toggle_scopes() {
    let s = analyze_hir(&parsed("theme-toggle")).unwrap();
    assert_eq!(s.function, "ThemeToggle");
    assert_eq!(s.params, 1);
    // From the spike: the effect scope depends reactively on `mode`; the JSX scope on
    // `themeLabel` and `label`; the handler scope has no deps.
    let by_deps: Vec<Vec<String>> = s.scopes.iter().map(|sc| sc.deps.iter().map(|d| d.name.clone()).collect()).collect();
    assert_eq!(s.scopes.len(), 3, "only live scopes (effect, handler, jsx): {by_deps:?}");
    assert!(s.scopes.iter().all(|sc| !sc.pruned), "{:?}", s.scopes);
    assert!(by_deps.contains(&vec!["mode".to_string()]), "{by_deps:?}");
    assert!(by_deps.contains(&Vec::<String>::new()), "handler scope has no deps: {by_deps:?}");
    assert!(by_deps.iter().any(|d| d.contains(&"themeLabel".to_string()) && d.contains(&"label".to_string())), "{by_deps:?}");
    assert!(s.scopes.iter().all(|sc| sc.deps.iter().all(|d| d.reactive)), "all deps here are reactive");
}

#[test]
fn static_component_has_no_reactive_scopes_but_succeeds() {
    let s = analyze_hir(&parsed("static-text")).unwrap();
    assert_eq!(s.function, "Hello");
    assert!(s.scopes.iter().all(|sc| sc.deps.iter().all(|d| d.name == "name")), "{:?}", s.scopes);
}

#[test]
fn arrow_default_export_is_reported_not_panicked() {
    let err = analyze_hir(&parsed("arrow-default")).unwrap_err();
    assert!(matches!(err, HirError::NoDefaultExportFunction), "{err:?}");
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p brust-compiler --test hir 2>&1 | tail -5`
Expected: `theme_toggle_scopes` and `static_component…` fail with `Unsupported("not implemented")`; the arrow test fails for the same reason.

- [ ] **Step 4: Add `pub(crate)` accessors to `Parsed`**

In `parse/mod.rs`, inside `impl Parsed`:

```rust
    pub(crate) fn ast(&self) -> &js_ast::Ast<'static> { &self.ast }
    pub(crate) fn source(&self) -> &js_ast::Source { &self.source }
    pub(crate) fn arena(&self) -> &bun_alloc::Arena { &self.arena }
```

- [ ] **Step 5: Implement `analyze/hir.rs`**

```rust
//! Bridge to Bun's React Compiler: implements its `Host` over a `Parsed` module and
//! runs the vendored `analyze_fn`. Returns plain-Rust `HirSummary` (spec §4.2(a)).
use crate::parse::Parsed;
use crate::summary::{DepInfo, HirSummary, ScopeInfo};
use bun_ast as js_ast;
use bun_react_compiler::{Host, JsxImportKind};

#[derive(Debug, thiserror::Error)]
pub enum HirError {
    #[error("no `export default function` in this module")]
    NoDefaultExportFunction,
    #[error("react compiler could not lower this component: {0}")]
    Unsupported(String),
}

struct AstHost<'a> {
    ast: &'a js_ast::Ast<'static>,
    source: &'a js_ast::Source,
    arena: &'a bun_alloc::Arena,
}

impl Host for AstHost<'_> {
    fn symbols(&self) -> &[js_ast::Symbol] { self.ast.symbols.as_slice() }
    fn module_scope(&self) -> &js_ast::Scope { &self.ast.module_scope }
    fn import_records(&self) -> &[js_ast::ImportRecord] { self.ast.import_records.as_slice() }
    fn source(&self) -> &[u8] { self.source.contents() }
    fn arena(&self) -> &bun_alloc::Arena { self.arena }
    fn ref_name(&self, r: js_ast::Ref) -> &[u8] {
        if r.is_source_contents_slice() {
            let start = r.source_index() as usize;
            &self.source.contents()[start..start + r.inner_index() as usize]
        } else {
            self.ast.symbols.as_slice()[r.inner_index() as usize].original_name.slice()
        }
    }
    fn scope_for_loc(&self, _loc: js_ast::Loc) -> Option<&js_ast::Scope> { None }
    fn jsx_import(&mut self, _kind: JsxImportKind) -> js_ast::Ref { js_ast::Ref::NONE }
    fn jsx_import_kind(&self, r: js_ast::Ref) -> Option<JsxImportKind> {
        if r.is_source_contents_slice() { return None; }
        let name = self.ref_name(r);
        Some(if name.starts_with(b"jsxDEV") { JsxImportKind::JsxDEV }
            else if name.starts_with(b"jsxs") { JsxImportKind::Jsxs }
            else if name.starts_with(b"jsx") { JsxImportKind::Jsx }
            else if name.starts_with(b"Fragment") { JsxImportKind::Fragment }
            else if name.starts_with(b"createElement") { JsxImportKind::CreateElement }
            else { return None })
    }
    fn is_jsx_classic(&self) -> bool { false }
    fn jsx_classic_factory(&mut self, _loc: js_ast::Loc) -> js_ast::Expr { unreachable!("classic jsx runtime is never configured") }
    fn new_generated(&mut self, name: &[u8]) -> js_ast::Ref { panic!("Host::new_generated({}) during analysis", String::from_utf8_lossy(name)) }
    fn new_local(&mut self, name: &[u8]) -> js_ast::Ref { panic!("Host::new_local({}) during analysis", String::from_utf8_lossy(name)) }
    fn record_usage(&mut self, _r: js_ast::Ref) {}
    fn add_import_record(&mut self, path: &[u8], _kind: js_ast::ImportKind) -> (u32, js_ast::Ref) { panic!("Host::add_import_record({}) during analysis", String::from_utf8_lossy(path)) }
}

pub fn analyze_hir(parsed: &Parsed) -> Result<HirSummary, HirError> {
    let ast = parsed.ast();
    let mut stmts: Vec<js_ast::Stmt> = Vec::new();
    let mut func: Option<&js_ast::G::Fn> = None;
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            stmts.push(stmt.clone());
            if let js_ast::stmt::Data::SExportDefault(ed) = &stmt.data
                && let js_ast::StmtOrExpr::Stmt(inner) = &ed.value
                && let js_ast::stmt::Data::SFunction(sf) = &inner.data
            {
                func = Some(&sf.func);
            }
        }
    }
    let func = func.ok_or(HirError::NoDefaultExportFunction)?;
    let fn_name = parsed.default_export_function_name().unwrap_or_default();

    let mut host = AstHost { ast, source: parsed.source(), arena: parsed.arena() };
    let bindings = bun_react_compiler::collect_import_bindings(&stmts, host.import_records(), host.symbols());
    let opts = bun_react_compiler::ReactCompilerOptions::default();
    let mut ctx = bun_react_compiler::imports::ProgramContext::new(opts, None, None, false);
    ctx.init_from_scope(host.symbols());
    let env_config = bun_react_compiler::EnvironmentConfig::default();

    let (reactive_fn, env) = bun_react_compiler::pipeline::analyze_fn(
        &bun_react_compiler::lowering::FunctionNode::Function(func),
        Some(&fn_name),
        &mut host,
        bun_react_compiler::hir::ReactFunctionType::Component,
        &env_config,
        &mut ctx,
        &bindings,
    )
    .map_err(|e| HirError::Unsupported(format!("{e:?}")))?;

    let name_of = |id: &bun_react_compiler::hir::IdentifierId| -> String {
        env.identifiers.iter().find(|i| &i.id == id)
            .and_then(|i| i.name.as_ref())
            .map(|n| match n {
                bun_react_compiler::hir::IdentifierName::Named(s) | bun_react_compiler::hir::IdentifierName::Promoted(s) => String::from_utf8_lossy(s.slice()).into_owned(),
            })
            .unwrap_or_else(|| format!("#{}", id.0))
    };
    // Only LIVE scopes: the ones that appear in the reactive body. `env.scopes` also keeps
    // scopes the passes pruned or merged away (ruling on challenge 40314014).
    use bun_react_compiler::hir::reactive::{ReactiveBlock, ReactiveStatement, ReactiveTerminal};
    use bun_react_compiler::hir::ScopeId;
    fn walk(block: &ReactiveBlock, out: &mut Vec<(ScopeId, bool)>) {
        for stmt in block {
            match stmt {
                ReactiveStatement::Instruction(_) => {}
                ReactiveStatement::Scope(b) => { out.push((b.scope, false)); walk(&b.instructions, out); }
                ReactiveStatement::PrunedScope(b) => { out.push((b.scope, true)); walk(&b.instructions, out); }
                ReactiveStatement::Terminal(t) => walk_terminal(&t.terminal, out),
            }
        }
    }
    // Exhaustive on purpose: a new ReactiveTerminal variant must fail to compile here.
    // Write one arm per variant of `ReactiveTerminal` (vendor/bun_react_compiler/hir/reactive.rs:145)
    // and call `walk` on every field of type `ReactiveBlock` (e.g. If { consequent, alternate, .. },
    // For { init, test, update, loop, .. }); variants with no block fields are `=> {}`.
    fn walk_terminal(t: &ReactiveTerminal, out: &mut Vec<(ScopeId, bool)>) {
        match t {
            // … one arm per variant, no `_ =>` …
        }
    }
    let mut live: Vec<(ScopeId, bool)> = Vec::new();
    walk(&reactive_fn.body, &mut live);
    let mut seen = std::collections::HashSet::new();
    let mut scopes: Vec<ScopeInfo> = live.into_iter().filter(|(id, _)| seen.insert(*id)).filter_map(|(id, pruned)| {
        let s = env.scopes.iter().find(|s| s.id == id)?;
        Some(ScopeInfo {
            id: id.0,
            pruned,
            deps: s.dependencies.iter().map(|d| DepInfo { name: name_of(&d.identifier), reactive: d.reactive }).collect(),
            decls: s.declarations.iter().map(|(id, _)| name_of(id)).collect(),
        })
    }).collect();
    scopes.sort_by_key(|s| s.id);

    Ok(HirSummary { function: fn_name, params: reactive_fn.params.len(), scopes, identifiers: env.identifiers.len() })
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p brust-compiler --test hir 2>&1 | tail -10`
Expected: 3 passed. If `theme_toggle_scopes` fails on dep names, print `s` with `{:#?}` and compare with the spike output in `docs/design/2026-10-08-bun-crate-link-spike.md` (scope 3 deps `[mode*]`, scope 6 deps `[themeLabel*, label*]`); the summary must reproduce those.

- [ ] **Step 7: Run the CLI end to end**

```bash
cargo run -q -p brust-compiler-cli -- tests/fixtures/theme-toggle/input.tsx --emit hir
```

Expected: JSON with `"function": "ThemeToggle"` and a `scopes` array containing a scope whose `deps` is `[{"name":"mode","reactive":true}]`.

- [ ] **Step 8: Commit**

```bash
git add crates tests/fixtures
git commit -m "feat(compiler): analyze_hir — reactive scopes via vendored React Compiler

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Golden fixtures runner

**Files:**
- Create: `crates/brust-compiler/tests/fixtures.rs`, `tests/fixtures/README.md`, `tests/fixtures/<case>/expected.hir.json` for `theme-toggle`, `static-text`; `tests/fixtures/arrow-default/expected.error.txt`

**Interfaces:**
- Produces: the convention every later plan extends: `tests/fixtures/<case>/input.tsx` + `expected.<emit>.<ext>`; `BRUSTC_UPDATE=1 cargo test --test fixtures` rewrites expectations.

- [ ] **Step 1: Write the runner (it is the test)**

`crates/brust-compiler/tests/fixtures.rs`:

```rust
//! Golden-file runner. For every tests/fixtures/<case>/input.tsx, produce each
//! emit this crate supports and compare with expected.<emit>.<ext>. Set
//! BRUSTC_UPDATE=1 to rewrite expectations after an intentional change.
use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures") }

fn check(path: &Path, actual: &str) {
    let update = std::env::var_os("BRUSTC_UPDATE").is_some();
    match std::fs::read_to_string(path) {
        Ok(expected) if expected == actual => {}
        Ok(expected) if !update => panic!("mismatch in {}\n--- expected\n{expected}\n--- actual\n{actual}", path.display()),
        _ if update => std::fs::write(path, actual).unwrap(),
        Err(e) => panic!("missing {} ({e}); run with BRUSTC_UPDATE=1 to create it", path.display()),
        Ok(_) => unreachable!(),
    }
}

#[test]
fn golden_hir() {
    let mut cases: Vec<PathBuf> = std::fs::read_dir(fixtures_dir()).unwrap().map(|e| e.unwrap().path()).filter(|p| p.join("input.tsx").exists()).collect();
    cases.sort();
    assert!(!cases.is_empty());
    for case in cases {
        let input = case.join("input.tsx");
        let parsed = brust_compiler::parse::parse_tsx(input.to_str().unwrap(), std::fs::read(&input).unwrap()).unwrap();
        match brust_compiler::analyze::hir::analyze_hir(&parsed) {
            Ok(summary) => check(&case.join("expected.hir.json"), &format!("{}\n", serde_json::to_string_pretty(&summary).unwrap())),
            Err(e) => check(&case.join("expected.error.txt"), &format!("{e}\n")),
        }
    }
}
```

- [ ] **Step 2: Generate expectations, inspect them, run again clean**

```bash
BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures 2>&1 | tail -3
cat tests/fixtures/theme-toggle/expected.hir.json
cat tests/fixtures/arrow-default/expected.error.txt
cargo test -p brust-compiler --test fixtures 2>&1 | tail -3
```

Expected: the first run writes three files; `expected.hir.json` for theme-toggle lists a scope with `"deps": [{"name": "mode", "reactive": true}]`; the error file reads `no \`export default function\` in this module`; the second run passes without `BRUSTC_UPDATE`.

- [ ] **Step 3: `tests/fixtures/README.md`**

```markdown
# Golden fixtures

`<case>/input.tsx` is compiled by `crates/brust-compiler/tests/fixtures.rs`; every emit
the compiler supports is compared byte-for-byte with `expected.<emit>.<ext>`
(`hir.json` today; later plans add `ir.json`, `jinja`, `server.ts`, `client.js`, `diag.txt`).
A case that is expected to fail has `expected.error.txt` instead.

After an intentional change: `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`,
then review the diff in git before committing.
```

- [ ] **Step 4: Commit**

```bash
git add crates/brust-compiler/tests/fixtures.rs tests/fixtures
git commit -m "test: golden fixture runner with BRUSTC_UPDATE

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a green `ci` check on every push/PR to `v2`, from a clean runner (Review Focus 5).

- [ ] **Step 1: Write the workflow**

```yaml
name: ci
on:
  push: { branches: [v2] }
  pull_request: { branches: [v2] }
jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: nightly-2026-09-15, components: "rust-src, rustfmt, clippy" }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.4.2" }
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/git
            ~/.cargo/registry
            target
          key: cargo-${{ runner.os }}-${{ hashFiles('Cargo.lock', 'rust-toolchain.toml') }}
          restore-keys: cargo-${{ runner.os }}-
      - run: cargo fmt --all -- --check
      - run: cargo build --workspace
      - run: cargo tree -p brust-compiler -i bun_react_compiler | tee tree.txt && grep -q "vendor/bun_react_compiler" tree.txt && ! grep -q "github.com/oven-sh/bun?rev" tree.txt
      - run: cargo clippy -p brust-compiler -p brust-compiler-cli -- -D warnings
      - run: cargo test --workspace
      - run: bun install --frozen-lockfile || true
      - run: bun check scripts/bun-codegen.ts
```

Note the `cargo tree` step: it fails the build if the vendored crate stopped shadowing the git one (Task 3 Step 6 invariant). The clippy step scopes to our crates only — Bun's vendored crate is not held to our lint settings.

- [ ] **Step 2: Make `cargo fmt --check` and clippy pass locally first**

```bash
cargo fmt --all
cargo clippy -p brust-compiler -p brust-compiler-cli -- -D warnings 2>&1 | tail -5
```

Fix every clippy finding in our two crates (do not add `#[allow]` on the stubs module beyond what Step 4 of Task 2 already lists).

- [ ] **Step 3: Commit, push, confirm green**

```bash
git add .github
git commit -m "ci: build, fixtures, clippy, bun check on v2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin v2
gh run watch --exit-status $(gh run list --branch v2 --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: `✓ ci`. The first run is cold (~5 min for the Bun clone + build); later runs hit the cache.

---

### Task 8: Rev-bump checklist and README

**Files:**
- Create: `docs/design/bun-rev-bump.md`, `README.md`

- [ ] **Step 1: Write the checklist (spec §10.4, made executable)**

`docs/design/bun-rev-bump.md`:

```markdown
# Bumping the pinned Bun rev

Do all steps in one PR. The rev appears in: `Cargo.toml` (8 lines), `bun-codegen/build_options.rs` (`SHA`),
`vendor/bun_react_compiler/BRUST-PATCH.md` (header), `crates/brust-compiler/src/parse/stubs/native.rs` (header).

1. Pick the rev (a commit on `main` that still has `src/sema/standalone/native.rs`). Export `REV=<40 hex>`.
2. Sparse checkout: `git clone --depth 1 --filter=blob:none --sparse https://github.com/oven-sh/bun /tmp/bun-src && git -C /tmp/bun-src fetch --depth 1 origin $REV && git -C /tmp/bun-src checkout $REV && git -C /tmp/bun-src sparse-checkout set src/sema/standalone src/react_compiler scripts/build`
3. `sed -i '' "s/rev = \"[0-9a-f]\{40\}\"/rev = \"$REV\"/" Cargo.toml`; copy `/tmp/bun-src/rust-toolchain.toml` over ours (keep our `components`).
4. `bun scripts/bun-codegen.ts /tmp/bun-src`; set `SHA` in `bun-codegen/build_options.rs` to `$REV`.
5. `cp /tmp/bun-src/src/sema/standalone/native.rs crates/brust-compiler/src/parse/stubs/native.rs` and restore the header line.
6. `rm -rf vendor/bun_react_compiler && cp -R /tmp/bun-src/src/react_compiler vendor/bun_react_compiler`, then re-apply every change listed in `vendor/bun_react_compiler/BRUST-PATCH.md` (the `sed` lines of plan M1a Task 3 Step 3 and the `analyze_fn` block). Update the header.
7. `cargo build --workspace`. For every undefined symbol at link time, add a stub in `crates/brust-compiler/src/parse/stubs/extra.rs` with the signature from Bun's `extern` block (`grep -rn "fn <name>" /tmp/bun-src/src`).
8. `cargo test --workspace`; if only golden files changed for a reason you understand, `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures` and review the diff.
9. Commit as `build: bump Bun to <rev>`; CI must be green before merge.
```

- [ ] **Step 2: Write `README.md`**

```markdown
# brust v2

Write React. Get a native page: HTML rendered by Rust from a compiled template, interactivity
as a small react-free chunk, React only where the compiler proves it is needed.

- Design: `docs/design/2026-10-08-react-compiler-design.md`
- Plans: `docs/plans/`
- Build: Rust `nightly-2026-09-15` (see `rust-toolchain.toml`) + Bun 1.4.x. `cargo test --workspace`.
- CLI: `cargo run -p brust-compiler-cli -- <file.tsx> --emit parse|hir`

This branch (`v2`) is an orphan rewrite; 0.1.x lives on `main`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/design/bun-rev-bump.md README.md
git commit -m "docs: Bun rev-bump checklist and README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage (M1a slice):** §4.1 → Task 2; §4.2(a) → Task 5; §9 layout → Tasks 1–4; §10.1–10.4 → Tasks 1, 3, 8; §11 golden-fixture convention → Task 6; CI gates (fmt, clippy, test, `bun check`) → Task 7. §4.2(b), §5–§8 and runtime-dom are M1b–M1e by design and not in this plan.
- **Type consistency:** `Parsed`, `ParseError`, `HirSummary`, `ScopeInfo`, `DepInfo`, `HirError`, `analyze_hir`, `parse_tsx` are named identically in Tasks 2, 4, 5, 6 and in the Interfaces block.
- **Amendment 2026-10-08 (challenge 40314014, ruled upheld):** `HirSummary.scopes` lists only scopes present in `reactive_fn.body` (with `pruned: bool`), not `env.scopes`; Task 5 Step 5, the Interfaces block and the theme-toggle test were changed accordingly.
- **Known soft spot:** Task 2 Step 5 names two `Msg` fields from memory (`m.kind`, `m.data.location`); the step says to read them off the checkout. The contract is the test, not the field names.
- **Review Focus → tests:** 1 → Task 2 `reports_syntax_error_with_position` + Task 4 `parse_error_exits_1_with_position`; 2 → Task 5 `arrow_default_export_is_reported_not_panicked`; 3 → Task 5 `static_component_has_no_reactive_scopes_but_succeeds`; 4 → Task 2 `two_parses_in_one_thread_do_not_interfere`; 5 → Task 7 cold CI run.

---

## Dispatch table (for the Coordinator)

Branch: `v2` (orphan). Lanes branch from `v2`, never from `main`. Worktrees live under
`/Users/detoro/code/brust/.claude/worktrees/<slug>` on branch `lane/<slug>`; the lead
creates each worktree from `v2` and merges each lane back into `v2`.

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m1a-foundation-core` | 1, 2, 3, 4, 5 | complex | Implementer (Complex) | — | complex | `cargo build --workspace` green; `cargo tree -p brust-compiler -i bun_react_compiler` shows `vendor/bun_react_compiler` and no git copy; `cargo test -p brust-compiler --test parse --test hir` and `cargo test -p brust-compiler-cli --test cli` all pass; `cargo run -q -p brust-compiler-cli -- tests/fixtures/theme-toggle/input.tsx --emit hir` prints a scope with deps `[{"name":"mode","reactive":true}]`. Paste the three command outputs (tails) in the READY note. |
| `m1a-fixtures-docs` | 6, 8 | standard | Implementer (Standard) | `m1a-foundation-core` merged | standard | `cargo test -p brust-compiler --test fixtures` passes without `BRUSTC_UPDATE`; `expected.hir.json` for theme-toggle and static-text plus `expected.error.txt` for arrow-default committed; `docs/design/bun-rev-bump.md` and `README.md` present. |
| `m1a-ci` | 7 | standard | Implementer (Standard) | `m1a-fixtures-docs` merged | standard | `cargo fmt --all -- --check` and `cargo clippy -p brust-compiler -p brust-compiler-cli -- -D warnings` clean locally; `.github/workflows/ci.yml` pushed on the lane and the `ci` run green on GitHub (paste the run URL). |

Gate commands any lane may ask the Runner to execute: `cargo fmt --all -- --check`,
`cargo clippy -p brust-compiler -p brust-compiler-cli -- -D warnings`, `cargo test --workspace`.
Escalations: design/spec conflicts → `task challenge` to the owner (lead); implementation
judgment inside the plan's intent → a `task note`, no escalation.
