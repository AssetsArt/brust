# Spec — Static / public asset serving

**Date:** 2026-06-02 · **Branch:** `feat/static-public-assets` · **Status:** design
**Gap:** `example/pokedex/FRAMEWORK-GAPS.md` — "ไม่มี static/public asset serving" (favicon 404, no public dir).

## Goal

Serve a project's `public/` directory as static files at the URL root, so
`public/favicon.ico` → `GET /favicon.ico`, `public/img/logo.png` → `GET /img/logo.png`.
Mirrors the existing `/_brust/islands/*` and `/_brust/css/*` serving paths.

Resolution model (decided): **boot-time manifest, static wins over app routes.**
At boot the server walks `public/` once and builds an in-memory map
`URL path → absolute file path`. Each request whose `GET` path is an exact key
in that map is served from disk before route matching runs. Non-matching paths
fall through to the existing route matcher unchanged.

## Non-goals

- **No HEAD/range/conditional (If-Modified-Since/ETag) support.** The server's
  method gate (`server.rs:200`) already allows only `GET` for general paths;
  public serving is GET-only. HEAD/range deferred.
- **No directory listing, no `index.html` auto-resolution.** Only exact file keys.
- **No hot-add at runtime.** The manifest is built at boot (configure time);
  adding a file to `public/` during a running dev server requires a restart —
  same model as island chunks.
- **No new Rust dependency** for MIME detection — a small built-in extension→type
  table covers the common web types; everything else is `application/octet-stream`.
- **No symlink-escape following.** Files are canonicalized and must resolve under
  the public root, or they are skipped at manifest-build time.
- No change to `/_brust/*` serving, route matching, or action dispatch precedence
  (`/_brust/*` handlers still run first; public wins only over app routes).

## High-level architecture

Three layers, mirroring `configure_css_dir` / `configure_islands_dir`:

### 1. Rust state + manifest (`crates/brust/src/lib.rs`)

```rust
// in the State struct (alongside islands_dir / css_dir):
public_assets: parking_lot::RwLock<std::collections::HashMap<String, std::path::PathBuf>>,
// init: RwLock::new(HashMap::new())

#[napi]
pub fn configure_public_dir(path: String) -> NapiResult<()> {
    // path must be absolute (mirror configure_css_dir's check).
    // Walk it recursively; for each regular file build the URL key and store
    // key -> canonicalized absolute path IF the canonical path stays under the
    // (canonicalized) public root. Replace the whole map under the write lock.
}
```

- **URL key derivation:** path of the file relative to the public root, with the
  OS separator normalized to `/`, prefixed with `/`. `public/favicon.ico` →
  `/favicon.ico`; `public/img/logo.png` → `/img/logo.png`.
- **MUST exclude `/_brust/` keys (security).** Several `/_brust/*` handlers run
  AFTER the public serve block in the request loop — MCP (`server.rs:~490`),
  `/_brust/page` nav (`~920`), cache-invalidate (`~576`), dev WS upgrade (`~800`).
  A file at `public/_brust/mcp` would otherwise shadow them. `configure_public_dir`
  therefore **skips any file whose derived URL key starts with `/_brust/`** and
  logs a warning. (Files under `/_brust/css/` and `/_brust/islands/` are handled
  before the public block, but excluding the whole `/_brust/` namespace is the
  correct, uniform guard.)
- **Traversal safety by construction:** the map's values are the only paths ever
  read; the request path is used solely as a `HashMap` key lookup — the request
  string is never joined to a directory. Canonicalize-under-root at build time
  additionally rejects symlinks pointing outside `public/`.
- A missing/empty `public/` → empty map (JS only calls `configure_public_dir`
  when the dir exists, mirroring css/islands).

Lookup helper in `server.rs`:
```rust
fn current_public_asset(url_path: &str) -> Option<std::path::PathBuf> {
    crate::state().public_assets.read().get(url_path).cloned()
}
```

### 2. MIME table (`crates/brust/src/server.rs`)

```rust
/// Extension → Content-Type for static public assets. Input is the resolved
/// FILE PATH from the manifest (not the URL) so MIME tracks the real file, not
/// URL structure; lowercased extension via rsplit('.'). Unknown → application/octet-stream.
fn content_type_for(file_path: &std::path::Path) -> &'static str { /* match on extension */ }
```
`eot` → `application/vnd.ms-fontobject`, `ico` → `image/x-icon`, `wasm` →
`application/wasm`. charset only on text/js/json/svg+xml; binary types none.
Covered (at least): html, css, js/mjs, json, map, svg, ico, png, jpg/jpeg, gif,
webp, avif, woff, woff2, ttf, otf, eot, txt, xml, pdf, wasm, mp4, webm, mp3, wav,
csv. `text/*` and `image/svg+xml`, `application/json`, `text/javascript` get
`; charset=utf-8` where appropriate; binary types do not.

### 3. Serve block (`crates/brust/src/server.rs`)

Inserted **after** the `/_brust/css/` block (~line 304) and **before** the action
dispatch / route matching block (~line 306). At that point `/_brust/*` is already
handled. Method is GET (or an action path — which is never a public key):

```rust
if method == "GET" {
    if let Some(file_path) = current_public_asset(path_no_query) {
        match tokio::fs::read(&file_path).await {
            Ok(bytes) => {
                let extra = [("Cache-Control".to_string(),
                              asset_cache_control(crate::is_dev_mode()).to_string())];
                let resp = http::build_response(
                    200, content_type_for(&file_path), &extra, bytes);
                if s.write_all(resp).await.is_err() { return; }
                continue;
            }
            Err(_) => { /* fall through to routing — manifest is stale */ }
        }
    }
}
```
A read error (file deleted after boot) falls through to routing rather than 500.

### 4. Boot wiring (`runtime/index.ts`)

Add `configurePublicDir(dir)` wrapper (mirrors `configureCssDir`) and wire it in
the prebuilt/source branches alongside CSS/islands:
- **prebuilt (dist):** `<distDir>/public` if it exists.
- **source (dev):** `<scanRoot>/public` if it exists.

`runtime/index.d.ts`: add `export declare function configurePublicDir(path: string): NapiResult<undefined>`.

### 5. Build copy (`runtime/cli/build.ts`)

After CSS/islands emit, if `<projectRoot>/public/` exists, `cp` it recursively to
`<outDir>/public/` so a deployed `dist/` is self-contained.
`<projectRoot>` = the directory of the build entry (the same dir used as scanRoot).

## CLI / API surface

- New napi export `configure_public_dir(path: string)` (camelCased `configurePublicDir`
  at the JS boundary — note `napi object camelcase` memory).
- No new CLI flags. Convention-based: a `public/` dir next to the entry.
- Authoring: drop files in `public/`; reference at root (`<img src="/logo.png">`,
  `<link rel="icon" href="/favicon.ico">`).

## File structure

```
crates/brust/src/lib.rs       MODIFIED — public_assets state + configure_public_dir napi + manifest walk
crates/brust/src/server.rs    MODIFIED — content_type_for, current_public_asset, serve block
runtime/index.ts              MODIFIED — configurePublicDir wrapper + dev/prebuilt wiring
runtime/index.d.ts            MODIFIED — configurePublicDir decl
runtime/cli/build.ts          MODIFIED — copy public/ → dist/public/
tests/static-assets.test.ts   NEW — integration (boot server, fetch assets)
example/pokedex/public/favicon.svg   NEW — dogfood (kills the favicon 404)
```

## Behavior invariants

- Precedence: `/_brust/*` > public manifest > app routes. (`/_brust/*` handlers
  `continue` before the public check; public check `continue`s before routing.)
- Only exact-key GET hits are served; everything else is byte-for-byte the old
  behavior (route matcher / 404).
- Request path is never used as a filesystem path component — pure map key.
- `asset_cache_control(dev)`: dev → `no-store`; prod → `public, max-age=3600`
  (reused, already tested).

## Tests

**Rust unit (`crates/brust/src/` `#[cfg(test)]`)**
- `content_type_for`: ico→image/x-icon (or image/vnd.microsoft.icon), png→image/png,
  svg→image/svg+xml; charset on text/js/json; unknown ext → application/octet-stream;
  no-extension → octet-stream; uppercase `.PNG` → image/png (case-insensitive).
- manifest URL-key derivation: nested path → `/a/b.png`; separator normalized;
  leading `/` present.
- (If feasible without an fs fixture, factor key-derivation into a pure fn and
  test it directly; the dir walk itself is exercised by the TS integration test.)

**TS integration (`tests/static-assets.test.ts`, boots the addon)**
- `GET /favicon.svg` → 200, `Content-Type: image/svg+xml`, body == file bytes.
- nested `GET /img/x.png` (fixture) → 200, `image/png`.
- `GET /does-not-exist.png` → falls through → 404 (not served).
- **static wins:** a public file whose key equals a real app route path is served
  from disk, not routed (use a throwaway fixture path that also has a route, or
  assert `/favicon.svg` is served as a file even though `/{...}`-style matching
  exists). At minimum assert a public asset at a path with no route returns the
  file and a non-asset path still routes.
- dev mode → `Cache-Control: no-store`.

**CLI build (`runtime/cli/build.test.ts` or the new file)**
- after `brust build`, `<outDir>/public/<file>` exists when the project has `public/`.

## Acceptance criteria

1. `cargo test --workspace --locked` green (new Rust unit tests included).
2. `cargo clippy --workspace --all-targets --locked -- -D warnings` clean; `cargo fmt --check` clean.
3. `cd runtime && bun run build` (rebuild addon after Rust change — stale-`.node` memory), then `bun test tests/static-assets.test.ts` green.
4. `bun run ci` (biome) clean on changed TS.
5. Manual smoke: boot pokedex, `curl -i localhost:PORT/favicon.svg` → 200 + correct CT; `curl -i .../nope.png` → 404; `curl .../` still renders the list page.
6. Existing baselines unchanged: runtime, native-island{,-ssr}, integration, cli-new.

## Known limitations / deferred

- No hot-add of `public/` files during a running server (restart required).
- GET-only (no HEAD/range/conditional requests).
- No content-hashing/fingerprinting of public assets (cache busting is the
  author's responsibility; prod cache is a flat `max-age=3600`).
- A read error after boot falls through to routing (typically yields the app's
  404), not a 500 — intentional.
- **Filenames must be URL-safe.** Manifest keys are raw filenames; request paths
  arrive percent-encoded. A `public/` file whose name has a space or non-ASCII
  char (`my logo.png`, `café.svg`) will never match an incoming request (`%20`,
  `%C3%A9`) and won't be served. `configure_public_dir` logs a warning for such
  files at boot. Use ASCII, no-space names. (Percent-decoding the request path is
  deferred.)
- **TOCTOU:** the canonicalize-under-root symlink guard runs at boot (manifest
  build) only. A `public/` file replaced by an out-of-root symlink AFTER boot is
  not re-validated before `tokio::fs::read`. Exploiting it needs local filesystem
  write access (outside the typical web threat model); restart rebuilds the
  manifest. Acceptable for v1.

## Open questions resolved at plan time

- **Precedence:** boot manifest, static wins (user-chosen).
- **HEAD:** out of scope (framework is GET-only at the gate).
- **MIME source:** built-in table, no dependency.
- **ico content-type:** use `image/x-icon` (widely compatible).
- **Dogfood asset:** add `example/pokedex/public/favicon.svg` (SVG favicon, no
  binary blob in the repo) and reference it via `<BrustPage>` if the head supports
  an icon link; otherwise just prove the route serves it. (Head-icon wiring is
  best-effort; the framework feature is the deliverable, not the pokedex favicon.)
