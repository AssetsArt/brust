# Plan — Static / public asset serving

**Spec:** `docs/superpowers/specs/2026-06-02-static-public-assets-design.md`
**Branch:** `feat/static-public-assets` · base `d821160`

TDD. Gates per task as noted. **After the Rust change, the napi addon MUST be
rebuilt (`cd runtime && bun run build`) before any `bun test` that boots the
server — a stale `.node` silently runs old Rust** (memory `stale-napi-node-after-compiler-change`).

## Spec-coverage map

| Spec section | Task |
|---|---|
| Rust state + `configure_public_dir` + manifest walk + `/_brust/` exclusion + canonicalize | Task 1 |
| MIME table `content_type_for(file_path)` + serve block + `current_public_asset` | Task 1 |
| Boot wiring (`runtime/index.ts` + `.d.ts`) dev/prebuilt | Task 2 |
| `brust build` copy `public/`→`dist/public/` | Task 3 |
| Integration tests + dogfood favicon | Task 3 |

---

## Task 1 — Rust: state, configure_public_dir, MIME, serve block (+ unit tests)

**Files:** `crates/brust/src/lib.rs`, `crates/brust/src/server.rs`.

### 1a. `lib.rs` — state field

In the `State` struct (after `css_dir`, ~line 59):
```rust
    /// URL path (`/favicon.ico`) → canonical absolute file path under public/.
    /// Built once at boot by `configure_public_dir`; replaced wholesale.
    public_assets: parking_lot::RwLock<std::collections::HashMap<String, std::path::PathBuf>>,
```
In `state()` init (after `css_dir: ...None)`, ~line 87):
```rust
            public_assets: parking_lot::RwLock::new(std::collections::HashMap::new()),
```

### 1b. `lib.rs` — pure key derivation + walk + napi

Add near `configure_islands_dir` (~line 327):
```rust
/// Derive the served URL key for a file path relative to the public root.
/// Normalizes the OS separator to `/` and prefixes `/`. Returns None for keys
/// in the reserved `/_brust/` namespace (those would shadow framework handlers
/// that run after the public serve block — MCP, /_brust/page, cache-invalidate,
/// dev WS). Pure — unit tested.
fn public_url_key(rel: &std::path::Path) -> Option<String> {
    let mut key = String::from("/");
    let mut first = true;
    for comp in rel.components() {
        let std::path::Component::Normal(os) = comp else {
            return None; // no `..`, root, prefix, curdir components
        };
        let part = os.to_str()?;
        if !first {
            key.push('/');
        }
        key.push_str(part);
        first = false;
    }
    if first {
        return None; // empty relative path
    }
    if key == "/_brust" || key.starts_with("/_brust/") {
        return None;
    }
    Some(key)
}

/// Walk `root` recursively and build the URL→file map. Skips files whose
/// canonical path escapes `root` (symlink guard) and reserved `/_brust/` keys.
fn build_public_manifest(root: &std::path::Path) -> std::collections::HashMap<String, std::path::PathBuf> {
    let mut map = std::collections::HashMap::new();
    let canon_root = match root.canonicalize() {
        Ok(r) => r,
        Err(_) => return map,
    };
    let mut stack = vec![canon_root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            // Canonicalize the file; must stay under the canonical root (symlink guard).
            let canon = match path.canonicalize() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if !canon.starts_with(&canon_root) {
                tracing::warn!("public: skipping {canon:?} (escapes public root)");
                continue;
            }
            let Ok(rel) = canon.strip_prefix(&canon_root) else {
                continue;
            };
            match public_url_key(rel) {
                Some(key) => {
                    map.insert(key, canon);
                }
                None => {
                    tracing::warn!("public: skipping reserved/invalid key for {rel:?}");
                }
            }
        }
    }
    map
}

/// Tell Rust where to read root-mapped static assets from (`<project>/public`
/// in dev, `<dist>/public` prebuilt). Walks the dir once and caches the
/// URL→file manifest. Path must be absolute.
#[napi]
pub fn configure_public_dir(path: String) -> NapiResult<()> {
    let abs = std::path::PathBuf::from(&path);
    if !abs.is_absolute() {
        return Err(napi::Error::from_reason(format!(
            "public_dir must be an absolute path (got {path:?})"
        )));
    }
    let manifest = build_public_manifest(&abs);
    tracing::info!("public: {} asset(s) from {abs:?}", manifest.len());
    *state().public_assets.write() = manifest;
    Ok(())
}
```

### 1c. `server.rs` — lookup helper + MIME + serve block

Near `current_css_dir` (~line 30):
```rust
fn current_public_asset(url_path: &str) -> Option<std::path::PathBuf> {
    crate::state().public_assets.read().get(url_path).cloned()
}

/// Content-Type for a static public file, keyed on its file extension
/// (lowercased). Unknown/none → application/octet-stream.
fn content_type_for(file_path: &std::path::Path) -> &'static str {
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml; charset=utf-8",
        Some("xml") => "application/xml; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("ico") => "image/x-icon",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        Some("pdf") => "application/pdf",
        Some("wasm") => "application/wasm",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}
```

Serve block — insert **immediately after the `/_brust/css/` block** (after its
closing `}` at ~line 304, before the `// Native-only route: server-function
dispatch.` comment at ~line 306):
```rust
        // Root-mapped static assets from the configured public/ dir. Boot-time
        // manifest (URL→file); static wins over app routes, but every /_brust/*
        // handler above already `continue`d. GET-only (the method gate above
        // already 405s non-GET general paths). `path_no_query` is used purely as
        // a map key — never joined to a path — so traversal is impossible here.
        if method == "GET" {
            if let Some(file_path) = current_public_asset(path_no_query) {
                if let Ok(bytes) = tokio::fs::read(&file_path).await {
                    let extra = [(
                        "Cache-Control".to_string(),
                        asset_cache_control(crate::is_dev_mode()).to_string(),
                    )];
                    let resp =
                        http::build_response(200, content_type_for(&file_path), &extra, bytes);
                    if s.write_all(resp).await.is_err() {
                        return;
                    }
                    continue;
                }
                // read error (file removed after boot) → fall through to routing
            }
        }
```

### 1d. Rust unit tests

In `lib.rs` `#[cfg(test)]` (or the existing test mod):
```rust
#[test]
fn public_url_key_derivation() {
    use std::path::Path;
    assert_eq!(public_url_key(Path::new("favicon.ico")).as_deref(), Some("/favicon.ico"));
    assert_eq!(public_url_key(Path::new("img/logo.png")).as_deref(), Some("/img/logo.png"));
    assert_eq!(public_url_key(Path::new("a/b/c.txt")).as_deref(), Some("/a/b/c.txt"));
    // reserved namespace excluded
    assert_eq!(public_url_key(Path::new("_brust/mcp")), None);
    assert_eq!(public_url_key(Path::new("_brust")), None);
    // traversal components rejected
    assert_eq!(public_url_key(Path::new("../etc/passwd")), None);
}
```
In `server.rs` `#[cfg(test)]` (alongside `asset_cache_control` tests ~line 1781):
```rust
#[test]
fn content_type_for_common_extensions() {
    use std::path::Path;
    assert_eq!(content_type_for(Path::new("/p/favicon.ico")), "image/x-icon");
    assert_eq!(content_type_for(Path::new("/p/a.png")), "image/png");
    assert_eq!(content_type_for(Path::new("/p/a.svg")), "image/svg+xml; charset=utf-8");
    assert_eq!(content_type_for(Path::new("/p/a.PNG")), "image/png"); // case-insensitive
    assert_eq!(content_type_for(Path::new("/p/a.woff2")), "font/woff2");
    assert_eq!(content_type_for(Path::new("/p/noext")), "application/octet-stream");
    assert_eq!(content_type_for(Path::new("/p/a.weird")), "application/octet-stream");
}
```

**Gate (Task 1):**
```
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked   # new unit tests green
```
**ESCALATE if:** clippy flags the `while let Some(dir) = stack.pop()` walk or
the `let ... else` (edition); report the exact lint — do not silence with `#[allow]`.

---

## Task 2 — TS boot wiring (`runtime/index.ts` + `runtime/index.d.ts`)

**Files:** `runtime/index.ts`, `runtime/index.d.ts`.

### 2a. Wrapper — after `configureCssDir` (~line 212):
```ts
  /** Tell Rust where to read root-mapped static assets (`/favicon.ico`, …) from.
   * Path must be absolute. */
  configurePublicDir(dir: string): void {
    ;(native as any).configurePublicDir(dir)
  },
```

### 2b. Wiring — after the CSS prebuilt/source block (~line 416, before the
jinja block at ~418). `scanRoot`, `distDir`, `prebuilt` are already in scope:
```ts
      // Static public assets — convention: <scanRoot>/public (dev) or
      // <distDir>/public (prebuilt). Root-mapped (public/favicon.ico → /favicon.ico).
      if (prebuilt) {
        const prebuiltPublicDir = path.join(distDir!, 'public')
        if (existsSync(prebuiltPublicDir)) {
          this.configurePublicDir(prebuiltPublicDir)
          console.log(`[brust] main: serving static assets from ${prebuiltPublicDir}`)
        }
      } else {
        const publicDir = path.join(scanRoot, 'public')
        if (existsSync(publicDir)) {
          this.configurePublicDir(publicDir)
          console.log(`[brust] main: serving static assets from ${publicDir}`)
        }
      }
```

### 2c. `runtime/index.d.ts` — add near `configureCssDir` (~line 14):
```ts
export declare function configurePublicDir(path: string): NapiResult<undefined>
```

**Gate (Task 2):** `bun run ci` (biome) clean. (No test boot here — covered in Task 3.)
**ESCALATE if:** `scanRoot`/`distDir`/`prebuilt`/`existsSync`/`path` are NOT in
scope at the insertion point — report what IS in scope; do not refactor the boot fn.

---

## Task 3 — build copy + integration tests + dogfood

**Files:** `runtime/cli/build.ts`, `tests/static-assets.test.ts` (NEW),
`example/pokedex/public/favicon.svg` (NEW).

### 3a. `build.ts` — copy public → dist. After the CSS emit block (~line 348,
before the bundle step ~line 391). `entryDir` and `outDir` are in scope:
```ts
  // Static public assets: copy <project>/public → <dist>/public so a deployed
  // dist is self-contained. No .brust mirror — the source/dev runtime reads
  // <scanRoot>/public directly.
  const publicSrc = path.join(entryDir, 'public')
  if (existsSync(publicSrc)) {
    const publicOut = path.join(outDir, 'public')
    await cp(publicSrc, publicOut, { recursive: true })
    console.log(`[brust build] public:  ${publicSrc} → ${publicOut}`)
  } else {
    console.log('[brust build] public:  skipped (no public/ dir)')
  }
```
(`cp` and `existsSync` are already imported in build.ts; confirm `existsSync`
import — if absent, add `import { existsSync } from 'node:fs'`.)

### 3b. Dogfood fixture — `example/pokedex/public/favicon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#ef4444"/><rect x="1" y="14" width="30" height="4" fill="#111"/><circle cx="16" cy="16" r="5" fill="#fff" stroke="#111" stroke-width="2"/></svg>
```

### 3c. `tests/static-assets.test.ts` — integration. FIRST read an existing
booting test (`tests/native-island-ssr.test.ts` and `tests/integration.test.ts`)
to copy the exact boot/teardown + port-allocation harness used in this repo
(`brust build` in beforeAll if native routes needed, spawn, poll a port, fetch).
Use a throwaway fixture app with a `public/` dir (or reuse the pokedex fixture if
the harness already builds it). Assertions:
- `GET /favicon.svg` → 200, header `content-type: image/svg+xml; charset=utf-8`, body bytes == the file.
- nested `GET /img/<file>` (add a tiny fixture file) → 200 with correct MIME.
- `GET /definitely-missing-1234.png` → NOT 200 (falls through → 404).
- a normal app route (e.g. the fixture's `/`) still returns its HTML (proves
  non-asset paths still route; static doesn't break routing).
- dev mode (boot with dev on, as the harness allows) → `cache-control: no-store`
  on the asset. If toggling dev in the harness is awkward, assert prod default
  `cache-control: public, max-age=3600` instead and note it.

Rebuild the addon before running: `cd runtime && bun run build` (Task 1 changed Rust).

**Gate (Task 3):**
```
cd runtime && bun run build && cd ..      # fresh .node
bun test tests/static-assets.test.ts      # green
bun run ci                                # biome clean
# regression: existing suites unaffected
bun test tests/integration.test.ts
```
**ESCALATE if:** the integration harness can't bind a port / flakes (memory
`native-island-integration-flake` — run the file alone), OR `brust build` does
not copy public into the fixture's dist — report the dist tree.

---

## Final gate (orchestrator, Phase 6)
1. `cargo fmt --check` · `cargo clippy --all-targets --locked -D warnings` · `cargo test --workspace --locked`
2. `cd runtime && bun run build` then `bun test tests/static-assets.test.ts`
3. `bun run ci`
4. `bun test runtime/` + `tests/{native-island,native-island-ssr,integration,cli-new}.test.ts` unchanged
5. Manual curl smoke: boot pokedex, `curl -i /favicon.svg` → 200 + image/svg+xml; `curl -i /nope.png` → 404; `curl /` → list page.
