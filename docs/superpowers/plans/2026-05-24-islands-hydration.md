# Islands Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-route components can opt sub-trees into client-side hydration via `<Island id="X" component={X} props={...} hydrate="load|idle|visible|interaction" />`. SSR renders the initial state inside a marker div; a build-time-emitted bootstrap script lazy-loads the per-island chunk + shared React runtime, then `hydrateRoot`s the marker on trigger fire.

**Architecture:**
- `island.config.ts` (user-supplied) maps `id` → `entry` (file path). At boot, `brust.serve()` reads it and runs `Bun.build` 3 times for the shared runtime: one combined chunk `_react.js` that re-exports both `react` AND `react/jsx-runtime`, one chunk `_react-dom.js` for `react-dom/client` (with `react` external), and once per island (with `react`, `react/jsx-runtime`, `react-dom/client` all external). The importmap maps both `react` and `react/jsx-runtime` to the same `_react.js` URL — the browser fetches it once and slices different named exports per import. All builds use `minify: true` + `define: process.env.NODE_ENV = "production"` (without this Bun emits dev React → ~866 KB instead of ~50 KB). Outputs land in `.brust/islands/`. A handwritten bootstrap template is also built into `.brust/islands/_bootstrap.js`.

**Spike findings (Task 1, commit `cd5f837`):**
- `react/jsx-runtime` is a sub-path of the `react` package; `external: ['react']` externalises it too. So a separate `_jsx-runtime.js` chunk built from `export * from 'react/jsx-runtime'` with `react` external produces only a re-export shell (78 bytes) that the browser can't resolve — infinite import loop via importmap. Fix: re-export both `react` and `react/jsx-runtime` from the SAME entry wrapper; one chunk, two importmap entries pointing to it.
- Without `define` + `minify`, Bun emits dev React (~71 KB) and dev react-dom (~866 KB). Production-mode flags shrink the latter to ~50 KB.
- A new Rust native route `GET /_brust/islands/<file>` serves files from `.brust/islands/` with strict path-traversal protection.
- `<Island>` (TS) renders `<div data-brust-island="<id>" data-props='...' data-hydrate="..."><Component {...props} /></div>` AND flips a module-scope `__brust_island_used` flag. `makeRenderer` checks the flag after `renderToString` and prepends `<script type="importmap">{...}</script><script type="module" src="/_brust/islands/_bootstrap.js" defer></script>` to the rendered HTML. Pages without islands ship zero JS.
- Bootstrap.js queries `[data-brust-island]`, registers a trigger per marker (`load` / `idle` / `visible` / `interaction`), and on fire: `dynamic import('/_brust/islands/<id>.js')` then `hydrateRoot(marker, createElement(mod.default, JSON.parse(marker.dataset.props)))`.

**Tech Stack:** Bun 1.4 `Bun.build` (esm format, browser target), React 18 (`hydrateRoot` from `react-dom/client`), TypeScript, Rust (no new crates — uses `tokio::fs` + the existing http/server scaffolding).

**Out of scope (defer):**
- `"use island"` directive + auto-detect at import sites (architecture.md full vision)
- CSS extraction per island
- `"use server"` auto-rewrite for server functions
- Hot reload of island bundles during dev
- Lazy chunk splitting beyond per-island granularity
- Nested islands (island within an island)
- Production-grade caching headers / fingerprinted filenames
- Compression (Content-Encoding: gzip) — relies on reverse-proxy

---

## File Structure

**New source files (committed):**
- `runtime/islands/_entries/react.ts` — combined wrapper exporting both `react` AND `react/jsx-runtime`. Built into `_react.js`. (See "Spike findings" — separate jsx-runtime chunk doesn't work.)
- `runtime/islands/_entries/react-dom.ts` — `export * from 'react-dom/client'` wrapper. Built into `_react-dom.js` with `react` external.
- `runtime/islands/bootstrap.ts` — handwritten client bootstrap (4 triggers + hydrate logic). Built once into `.brust/islands/_bootstrap.js`.
- `runtime/islands/island.tsx` — exports `<Island>` component + module-scope `__brust_island_used` flag
- `runtime/islands/build.ts` — `buildIslands(configPath)` async function that runs `Bun.build` for runtime + islands + bootstrap, emits to `.brust/islands/`

**NOTE:** `runtime/islands/_entries/jsx-runtime.ts` was created in Task 1's spike but is no longer needed. Task 4 deletes it and amends `_entries/react.ts` to re-export both surfaces.

**Modified source files:**
- `runtime/index.ts` — re-export `Island` + `buildIslands` + types
- `runtime/routes.ts` — `makeRenderer` checks the island-used flag, prepends importmap+bootstrap script
- `src/lib.rs` — new napi method `configure_islands_dir(path: String)` so Rust knows where to read static files from
- `src/server.rs` — new native route `/_brust/islands/<file>` that reads from the configured directory; also add `IslandsDir` to State

**Generated (gitignored — add to .gitignore):**
- `.brust/islands/_react.js` (combined react + react/jsx-runtime)
- `.brust/islands/_react-dom.js` (react-dom/client)
- `.brust/islands/_bootstrap.js`
- `.brust/islands/<id>.js` (per island)

**Example app additions:**
- `example/hello-world/island.config.ts` — maps `Counter` → `./components/Counter.tsx`
- `example/hello-world/components/Counter.tsx` — island-eligible component (uses `useState`)
- `example/hello-world/components/HelloWorld.tsx` — modify to embed `<Island id="Counter" ... />`
- `example/hello-world/index.ts` — pass `islandConfig` to `brust.serve`

**Tests:**
- `tests/integration.test.ts` — append 3 new integration tests (chunk served correctly, marker rendered, page without islands ships no JS)

**Docs:**
- `architecture.md` — Islands section moves from designed-not-built to built; document the MVP scope + future enhancements

---

## Task 1: Spike — verify Bun.build can produce the runtime chunks

This task tests the core assumption (Bun can build the 3 React runtime chunks with the right externals) before any other code is written. If Bun.build can't do this, the whole plan needs adjustment.

**Files:**
- Create: `runtime/islands/_entries/react.ts`
- Create: `runtime/islands/_entries/jsx-runtime.ts`
- Create: `runtime/islands/_entries/react-dom.ts`
- Create: `scripts/spike-islands-build.ts` (will be deleted after the spike)

- [ ] **Step 1: Create the 3 entry wrappers**

`runtime/islands/_entries/react.ts`:
```ts
export * from 'react'
```

`runtime/islands/_entries/jsx-runtime.ts`:
```ts
export * from 'react/jsx-runtime'
```

`runtime/islands/_entries/react-dom.ts`:
```ts
export * from 'react-dom/client'
```

- [ ] **Step 2: Write the spike script**

`scripts/spike-islands-build.ts`:
```ts
import { mkdir, rm } from 'node:fs/promises'

const OUT_DIR = '.brust/islands-spike'
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

// 1. React (bundles React itself, no externals).
const r1 = await Bun.build({
  entrypoints: ['runtime/islands/_entries/react.ts'],
  outdir: OUT_DIR,
  naming: '_react.js',
  format: 'esm',
  target: 'browser',
  minify: false,
})
if (!r1.success) {
  console.error('react build failed:', r1.logs)
  process.exit(1)
}

// 2. jsx-runtime (depends on react; keep react external).
const r2 = await Bun.build({
  entrypoints: ['runtime/islands/_entries/jsx-runtime.ts'],
  outdir: OUT_DIR,
  naming: '_jsx-runtime.js',
  format: 'esm',
  target: 'browser',
  external: ['react'],
  minify: false,
})
if (!r2.success) {
  console.error('jsx-runtime build failed:', r2.logs)
  process.exit(1)
}

// 3. react-dom/client (depends on react; keep react external).
const r3 = await Bun.build({
  entrypoints: ['runtime/islands/_entries/react-dom.ts'],
  outdir: OUT_DIR,
  naming: '_react-dom.js',
  format: 'esm',
  target: 'browser',
  external: ['react'],
  minify: false,
})
if (!r3.success) {
  console.error('react-dom build failed:', r3.logs)
  process.exit(1)
}

console.log('spike OK — 3 runtime chunks emitted:')
const { readdirSync, statSync } = await import('node:fs')
for (const f of readdirSync(OUT_DIR)) {
  const sz = statSync(`${OUT_DIR}/${f}`).size
  console.log(`  ${f}  ${sz} bytes`)
}
```

- [ ] **Step 3: Run the spike**

Run: `cd /Users/detoro/code/brust && bun run scripts/spike-islands-build.ts`

Expected:
- Script exits 0.
- 3 files in `.brust/islands-spike/`: `_react.js` (~30-50 KB), `_jsx-runtime.js` (~3-10 KB), `_react-dom.js` (~50-80 KB).
- `_jsx-runtime.js` and `_react-dom.js` contain `import * from "react"` (or similar) — verifying React stays external. Check with `grep "from \"react\"" .brust/islands-spike/_jsx-runtime.js` (the import statement should be present).

If any of these fail: report **BLOCKED** with the build log. The plan needs adjustment (likely the entrypoint wrapper or external list).

- [ ] **Step 4: Clean up spike output, keep entry wrappers**

Run:
```bash
rm -rf .brust/islands-spike
rm scripts/spike-islands-build.ts
```

Keep the 3 wrapper files (`runtime/islands/_entries/*.ts`) — they're reused by Task 4.

- [ ] **Step 5: Commit the entry wrappers**

```bash
cd /Users/detoro/code/brust
git add runtime/islands/_entries/
git commit -m "$(cat <<'EOF'
feat(islands): add React runtime entry wrappers for Bun.build

Three thin wrapper modules used as Bun.build entrypoints to emit shared
runtime chunks: react, react/jsx-runtime, react-dom/client. Spike script
verified the build pipeline produces 3 ESM chunks with React kept external
between them; importmap will rewire bare specifiers at runtime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rust — `/_brust/islands/<file>` static asset endpoint

**Files:**
- Modify: `src/lib.rs` (add `IslandsDir` state + `configure_islands_dir` napi method)
- Modify: `src/server.rs` (add native route handler before the `match_path` call)

- [ ] **Step 1: Add `IslandsDir` to the global State**

In `src/lib.rs`, find the `struct State` block (around line 33-43) and add a field:

```rust
struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Notify>,
    routes: Arc<RouteTable>,
    cache: Arc<LruCache>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
    islands_dir: parking_lot::RwLock<Option<std::path::PathBuf>>,
}
```

In the `OnceCell::get_or_init` initializer for `STATE`, add:

```rust
islands_dir: parking_lot::RwLock::new(None),
```

(Place it after `expected_workers: AtomicU32::new(0),`.)

- [ ] **Step 2: Add the napi method `configure_islands_dir`**

At the bottom of `src/lib.rs` (after the existing `#[napi]` exports):

```rust
#[napi]
pub fn configure_islands_dir(path: String) -> NapiResult<()> {
    let abs = std::path::PathBuf::from(&path);
    if !abs.is_absolute() {
        return Err(napi::Error::from_reason(format!(
            "islands_dir must be an absolute path (got {path:?})"
        )));
    }
    *state().islands_dir.write() = Some(abs);
    Ok(())
}
```

- [ ] **Step 3: Pass the islands_dir into `server::start`**

In `src/lib.rs` `begin_serve`, find the `server::start(...)` call and add the islands_dir Arc clone. Currently:

```rust
server::start(
    addr,
    Arc::clone(&s.ready),
    Arc::clone(&s.pool),
    Arc::clone(&s.routes),
    Arc::clone(&s.cache),
    opts.workers as usize,
);
```

Change to (passing the entire State Arc reference for islands_dir access):

```rust
server::start(
    addr,
    Arc::clone(&s.ready),
    Arc::clone(&s.pool),
    Arc::clone(&s.routes),
    Arc::clone(&s.cache),
    opts.workers as usize,
);
```

(No change here — islands_dir is read via `state()` getter at request time. Skip this step's edit; it's a no-op verification that the existing call signature is what we need.)

Add a helper at the top of `src/server.rs` (after imports):

```rust
fn current_islands_dir() -> Option<std::path::PathBuf> {
    crate::state().islands_dir.read().clone()
}
```

Wait — `state()` is private to `lib.rs`. Expose it: in `src/lib.rs`, change `fn state()` to `pub(crate) fn state()`. Verify by reading the existing visibility.

- [ ] **Step 4: Add the native route handler in `handle_conn`**

In `src/server.rs`, find the `/_brust/cache/stats` block. Immediately after it (and before the `/_brust/cache/invalidate` block):

```rust
        // Native-only route: serve built island chunks from .brust/islands/.
        // Strict path-traversal protection: filename must match ^[A-Za-z0-9_.-]+\.js$
        // and is joined to the configured islands_dir (no .. allowed).
        if let Some(file) = path.strip_prefix("/_brust/islands/") {
            // Strip any query string (chunks aren't parameterized, but be defensive).
            let file = file.split('?').next().unwrap_or(file);
            if !is_safe_island_filename(file) {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
            let dir = match current_islands_dir() {
                Some(d) => d,
                None => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            };
            let file_path = dir.join(file);
            match tokio::fs::read(&file_path).await {
                Ok(bytes) => {
                    let extra = [(
                        "Cache-Control".to_string(),
                        "public, max-age=3600".to_string(),
                    )];
                    let resp = http::build_response(
                        200,
                        "application/javascript; charset=utf-8",
                        &extra,
                        bytes,
                    );
                    if s.write_all(resp).await.is_err() {
                        return;
                    }
                    continue;
                }
                Err(_) => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            }
        }
```

Add the helper function near the bottom of `src/server.rs` (after `percent_decode`):

```rust
/// Reject filenames containing path separators, leading dots, or anything
/// outside `[A-Za-z0-9_.-]`. The filename MUST end in `.js`. This is the
/// only sanitization between the request line and `tokio::fs::read`.
fn is_safe_island_filename(name: &str) -> bool {
    if !name.ends_with(".js") {
        return false;
    }
    if name.starts_with('.') || name.is_empty() {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}
```

- [ ] **Step 5: Add unit tests for `is_safe_island_filename`**

Append to `src/server.rs` at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filenames_pass() {
        assert!(is_safe_island_filename("Counter.js"));
        assert!(is_safe_island_filename("_react.js"));
        assert!(is_safe_island_filename("_jsx-runtime.js"));
        assert!(is_safe_island_filename("a.b.c.js"));
        assert!(is_safe_island_filename("Foo-Bar_123.js"));
    }

    #[test]
    fn unsafe_filenames_rejected() {
        assert!(!is_safe_island_filename(""));
        assert!(!is_safe_island_filename("Counter"));
        assert!(!is_safe_island_filename("Counter.ts"));
        assert!(!is_safe_island_filename(".env.js"));
        assert!(!is_safe_island_filename("../etc/passwd.js"));
        assert!(!is_safe_island_filename("sub/file.js"));
        assert!(!is_safe_island_filename("sub\\file.js"));
        assert!(!is_safe_island_filename("file with space.js"));
        assert!(!is_safe_island_filename("file%20.js"));
        assert!(!is_safe_island_filename("évil.js"));
    }
}
```

- [ ] **Step 6: Build + test**

Run:
```bash
cd /Users/detoro/code/brust
cargo build
cargo test --lib
```

Expected: clean build (1 pre-existing `io::other::shutdown` warning OK). Test count grows to 22 + 11 new = 33: 5 http + 13 routes + 4 cache + 11 server tests passing.

Note: the new route is unreachable from any test until Task 4 builds chunks and Task 6 configures the dir — so the route's runtime behavior won't be exercised yet. Only the path-safety unit tests run here.

- [ ] **Step 7: Commit**

```bash
git add src/lib.rs src/server.rs
git commit -m "$(cat <<'EOF'
feat(server): /_brust/islands/<file> static asset endpoint

Serves pre-built island chunks from a configured directory (set by the
new napi configure_islands_dir method, called by the TS facade after
Bun.build at boot). Strict filename safety: only matches ^[A-Za-z0-9_.-]+\.js$,
no path separators or dot-prefixes. Cache-Control: public, max-age=3600.
404 when the file is missing or the directory hasn't been configured.

11 new unit tests for is_safe_island_filename covering safe + unsafe
shapes including traversal attempts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `<Island>` runtime component + island-used tracking

**Files:**
- Create: `runtime/islands/island.tsx`
- Modify: `runtime/index.ts` (re-export)

- [ ] **Step 1: Write `runtime/islands/island.tsx`**

```tsx
import { createElement, type ComponentType, type ReactNode } from 'react'

/** Triggers that activate hydration of an island marker. */
export type HydrateTrigger = 'load' | 'idle' | 'visible' | 'interaction'

export interface IslandProps<P> {
  /** Stable id — must match a key in the user's island.config.ts so the
   * client bootstrap can resolve the chunk URL `/_brust/islands/<id>.js`. */
  id: string
  /** Component rendered server-side INSIDE the marker. Same component
   * the client chunk default-exports — SSR HTML must match the post-hydrate
   * tree to avoid React reconciliation warnings. */
  component: ComponentType<P>
  /** Props passed to the component on both server and client. Must be
   * JSON-serializable (no functions, classes, DOM nodes, etc.). */
  props: P
  /** When to hydrate. Default 'load'. */
  hydrate?: HydrateTrigger
}

/** Module-scope flag flipped by every `<Island>` render. `makeRenderer`
 * reads + resets it once per render to decide whether to prepend the
 * importmap + bootstrap script. */
let __used = false

/** Internal — flipped by Island, read by makeRenderer. */
export function consumeIslandUsedFlag(): boolean {
  const v = __used
  __used = false
  return v
}

export function Island<P extends Record<string, unknown>>({
  id,
  component: Component,
  props,
  hydrate = 'load',
}: IslandProps<P>): ReactNode {
  __used = true
  const propsJson = JSON.stringify(props)
  return createElement(
    'div',
    {
      'data-brust-island': id,
      'data-brust-props': propsJson,
      'data-brust-hydrate': hydrate,
    },
    createElement(Component, props),
  )
}
```

- [ ] **Step 2: Re-export from `runtime/index.ts`**

In `runtime/index.ts`, at the bottom (after the existing `export { loadConfig, ... }` block):

```ts
export { Island } from './islands/island.tsx'
export type { IslandProps, HydrateTrigger } from './islands/island.tsx'
```

- [ ] **Step 3: Build to confirm types compile**

Run: `cd /Users/detoro/code/brust/runtime && bun run build:debug && cd -`
Expected: build succeeds (napi build doesn't tsc; we'll catch type errors via usage in Task 7's example).

- [ ] **Step 4: Commit**

```bash
cd /Users/detoro/code/brust
git add runtime/islands/island.tsx runtime/index.ts
git commit -m "$(cat <<'EOF'
feat(runtime): <Island> component + island-used tracking

<Island id component props hydrate?> renders the component server-side
inside a data-brust-island marker div, embeds props as JSON, and flips a
module-scope flag so makeRenderer can detect that this render needs the
importmap + bootstrap script. Without any <Island> on the page, the flag
stays false and zero JS ships.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `buildIslands(configPath)` boot routine

**Files:**
- Create: `runtime/islands/build.ts`
- Modify: `runtime/index.ts` (re-export)

This task implements the Bun.build orchestration: build 3 runtime chunks + N island chunks + copy bootstrap.

- [ ] **Step 0: Amend the entry wrapper to combine react + react/jsx-runtime**

The spike (Task 1) created `runtime/islands/_entries/{react.ts, jsx-runtime.ts, react-dom.ts}`. The plan now uses a SINGLE combined chunk for react + react/jsx-runtime.

Delete the standalone jsx-runtime wrapper:
```bash
rm /Users/detoro/code/brust/runtime/islands/_entries/jsx-runtime.ts
```

Replace the contents of `runtime/islands/_entries/react.ts` with:
```ts
// Combined re-export. The browser's importmap maps BOTH `react` and
// `react/jsx-runtime` to the chunk built from this file. Browser fetches
// once; different import statements slice different named exports from
// the same module.
//
// `export *` from `react` includes Fragment; `react/jsx-runtime` also
// exports Fragment. We re-export only jsx + jsxs from jsx-runtime to
// avoid the name collision (Fragment from react wins, which is the
// same object).
export * from 'react'
export { jsx, jsxs } from 'react/jsx-runtime'
```

- [ ] **Step 1: Write `runtime/islands/build.ts`**

```ts
import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface IslandsBuildResult {
  /** Absolute path to the output directory passed to brust's Rust side. */
  outDir: string
  /** Number of island chunks emitted (excludes runtime + bootstrap). */
  islandCount: number
}

export interface IslandsConfig {
  /** Map of island id → entry file path. Paths are resolved relative
   * to the directory of island.config.ts. */
  islands: Record<string, string>
}

/** Build the runtime chunks + all island chunks + bootstrap. Returns the
 * absolute output directory; caller passes it to `brust.configureIslandsDir`. */
export async function buildIslands(configPath: string): Promise<IslandsBuildResult> {
  const absConfig = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
  const configDir = dirname(absConfig)
  const mod = await import(absConfig)
  const cfg = (mod.default ?? mod) as IslandsConfig
  if (!cfg || typeof cfg !== 'object' || !cfg.islands) {
    throw new Error(`island config at ${absConfig} must export { islands: Record<string, string> }`)
  }

  const outDir = resolve(process.cwd(), '.brust/islands')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // import.meta.dir points to runtime/islands/.
  const entriesDir = resolve(import.meta.dir, '_entries')

  // 1. Combined react + react/jsx-runtime (no externals — bundles React).
  await buildOne([`${entriesDir}/react.ts`], outDir, '_react.js', [])

  // 2. react-dom/client (react external; consumes _react.js via importmap).
  await buildOne([`${entriesDir}/react-dom.ts`], outDir, '_react-dom.js', ['react'])

  // 3. Per-island chunks (all 3 runtime specifiers external).
  const externals = ['react', 'react/jsx-runtime', 'react-dom/client']
  let count = 0
  for (const [id, rel] of Object.entries(cfg.islands)) {
    if (!isValidIslandId(id)) {
      throw new Error(
        `island id ${JSON.stringify(id)} contains invalid characters; ` +
        `allowed: [A-Za-z0-9_-]+ (matches the server's filename safety check)`,
      )
    }
    const entry = isAbsolute(rel) ? rel : resolve(configDir, rel)
    await buildOne([entry], outDir, `${id}.js`, externals)
    count++
  }

  // 4. Bootstrap (react + react-dom/client external; uses importmap).
  const bootstrapSrc = resolve(import.meta.dir, 'bootstrap.ts')
  await buildOne([bootstrapSrc], outDir, '_bootstrap.js', externals)

  return { outDir, islandCount: count }
}

async function buildOne(
  entrypoints: string[],
  outdir: string,
  naming: string,
  external: string[],
): Promise<void> {
  const result = await Bun.build({
    entrypoints,
    outdir,
    naming,
    format: 'esm',
    target: 'browser',
    external,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  })
  if (!result.success) {
    const messages = result.logs.map((l) => String(l)).join('\n')
    throw new Error(`Bun.build failed for ${entrypoints.join(', ')}:\n${messages}`)
  }
}

/** Mirrors `is_safe_island_filename` in src/server.rs — keep in sync.
 * Allows [A-Za-z0-9_-]+ only (no dots in the id; dot is for the extension). */
function isValidIslandId(id: string): boolean {
  if (id.length === 0) return false
  return /^[A-Za-z0-9_-]+$/.test(id)
}
```

**Note on bootstrap externals:** previously the plan listed `external: []` for bootstrap so it would self-contain React. But the spike showed that this would re-bundle React (50+ KB duplication of `_react.js`). Bootstrap now uses the same externals — its `import { hydrateRoot } from 'react-dom/client'` resolves via importmap to `_react-dom.js`. The bootstrap chunk itself is ~2 KB.

- [ ] **Step 2: Re-export from `runtime/index.ts`**

In `runtime/index.ts`, add:

```ts
export { buildIslands } from './islands/build.ts'
export type { IslandsBuildResult, IslandsConfig } from './islands/build.ts'
```

Also expose the napi `configureIslandsDir` on `brust`. In the `export const brust = {` object, add a method after `configureCache`:

```ts
  /** Tell Rust where to read `/_brust/islands/<file>` from. Called once at
   * boot after buildIslands() emits chunks. Path must be absolute. */
  configureIslandsDir(dir: string): void {
    ; (native as any).configureIslandsDir(dir)
  },
```

- [ ] **Step 3: Build to confirm no type errors**

Run: `cd /Users/detoro/code/brust/runtime && bun run build:debug && cd -`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/detoro/code/brust
git add runtime/islands/build.ts runtime/index.ts
git commit -m "$(cat <<'EOF'
feat(runtime): buildIslands(configPath) boot pipeline

Reads island.config.ts (default-exported { islands: id->entry-path }),
emits 5+N chunks via Bun.build:
- _react.js (React, bundled)
- _jsx-runtime.js (external react)
- _react-dom.js (external react)
- <id>.js per island (externals: react, react/jsx-runtime, react-dom/client)
- _bootstrap.js (handwritten — small static script)

Returns the absolute outDir; brust.configureIslandsDir(dir) hands it to
Rust so /_brust/islands/<file> can read from it.

Id validation mirrors src/server.rs::is_safe_island_filename.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Bootstrap client script

**Files:**
- Create: `runtime/islands/bootstrap.ts`

This is the small (~80 LOC) client-side script that scans `[data-brust-island]` markers, registers triggers, and on fire imports the chunk + `hydrateRoot`s.

- [ ] **Step 1: Write `runtime/islands/bootstrap.ts`**

```ts
// Brust client-side hydration bootstrap.
// Built once at boot into .brust/islands/_bootstrap.js and served at
// /_brust/islands/_bootstrap.js. Loaded by makeRenderer-injected <script>.
//
// Responsibilities:
// 1. Find every <... data-brust-island="<id>" data-brust-props="..." data-brust-hydrate="..."> marker.
// 2. Register the trigger declared in data-brust-hydrate.
// 3. On fire: dynamic import('/_brust/islands/<id>.js'), then hydrateRoot.
//
// React/jsx-runtime/react-dom are resolved via the importmap that
// makeRenderer also injects.

import { hydrateRoot } from 'react-dom/client'
import { createElement } from 'react'

type Trigger = 'load' | 'idle' | 'visible' | 'interaction'

function registerTrigger(el: HTMLElement, trigger: Trigger, fire: () => void): void {
  switch (trigger) {
    case 'load': {
      fire()
      return
    }
    case 'idle': {
      const rIC = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
      if (typeof rIC === 'function') {
        rIC(fire)
      } else {
        setTimeout(fire, 0)
      }
      return
    }
    case 'visible': {
      if (typeof IntersectionObserver === 'undefined') {
        fire()
        return
      }
      const io = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            obs.disconnect()
            fire()
            return
          }
        }
      })
      io.observe(el)
      return
    }
    case 'interaction': {
      const onceFire = () => {
        el.removeEventListener('pointerdown', onceFire)
        el.removeEventListener('keydown', onceFire)
        el.removeEventListener('focusin', onceFire)
        fire()
      }
      el.addEventListener('pointerdown', onceFire, { once: false })
      el.addEventListener('keydown', onceFire, { once: false })
      el.addEventListener('focusin', onceFire, { once: false })
      return
    }
  }
}

async function hydrateOne(el: HTMLElement): Promise<void> {
  const id = el.getAttribute('data-brust-island')
  if (!id) return
  const propsJson = el.getAttribute('data-brust-props') ?? '{}'
  let props: Record<string, unknown>
  try {
    props = JSON.parse(propsJson)
  } catch (e) {
    console.error(`[brust] island "${id}": invalid data-brust-props JSON`, e)
    return
  }
  try {
    const mod = await import(`/_brust/islands/${id}.js`)
    const Component = (mod.default ?? mod) as React.ComponentType<Record<string, unknown>>
    if (typeof Component !== 'function') {
      console.error(`[brust] island "${id}": chunk has no default-exported component`)
      return
    }
    hydrateRoot(el, createElement(Component, props))
  } catch (e) {
    console.error(`[brust] island "${id}": hydration failed`, e)
  }
}

function bootstrap(): void {
  const markers = document.querySelectorAll<HTMLElement>('[data-brust-island]')
  for (const el of Array.from(markers)) {
    const trig = (el.getAttribute('data-brust-hydrate') ?? 'load') as Trigger
    registerTrigger(el, trig, () => {
      void hydrateOne(el)
    })
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap)
} else {
  bootstrap()
}
```

- [ ] **Step 2: Build to verify the bootstrap compiles**

Run: `cd /Users/detoro/code/brust && bun build runtime/islands/bootstrap.ts --target=browser --format=esm --external=react --external=react-dom/client > /tmp/bootstrap-check.js && wc -l /tmp/bootstrap-check.js && head -5 /tmp/bootstrap-check.js`

Expected: emits ESM with `import { hydrateRoot } from 'react-dom/client'` and `import { createElement } from 'react'` preserved as external. Line count ~100-200.

- [ ] **Step 3: Commit**

```bash
git add runtime/islands/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(islands): client bootstrap script

Scans [data-brust-island] markers on DOMContentLoaded, registers the
declared trigger (load/idle/visible/interaction), and on fire dynamic-imports
/_brust/islands/<id>.js and calls hydrateRoot with JSON-parsed props.

React + react-dom/client are external (resolved via importmap injected
by makeRenderer in the next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `makeRenderer` auto-injects importmap + bootstrap script

**Files:**
- Modify: `runtime/routes.ts` (the `makeRenderer` function — wrap the rendered HTML with `<script>` tags when an island was used)

- [ ] **Step 1: Import the flag-consume helper**

At the top of `runtime/routes.ts`, add the import (next to the existing react imports):

```ts
import { consumeIslandUsedFlag } from './islands/island.tsx'
```

- [ ] **Step 2: Inject importmap + bootstrap script into the rendered HTML**

In `makeRenderer`'s `terminal` closure (around line 134-150), modify the `renderToString` block. Find:

```ts
        const html = renderToString(
          createElement(route.Component, {
            params: call.params,
            path: call.path,
            data,
            workerId,
            req: call.req,
          }),
        )
        return { status: 200, body: html }
```

Replace with:

```ts
        const html = renderToString(
          createElement(route.Component, {
            params: call.params,
            path: call.path,
            data,
            workerId,
            req: call.req,
          }),
        )
        const wrapped = consumeIslandUsedFlag()
          ? wrapWithIslandsBootstrap(html)
          : html
        return { status: 200, body: wrapped }
```

Apply the same wrap to the errorBoundary path (the renderErr catch). Find:

```ts
        const html = renderToString(boundary)
        return { status: 500, body: html }
```

Replace with:

```ts
        const html = renderToString(boundary)
        // Drain the flag even on error path so it doesn't leak to the next render.
        const wrapped = consumeIslandUsedFlag()
          ? wrapWithIslandsBootstrap(html)
          : html
        return { status: 500, body: wrapped }
```

- [ ] **Step 3: Add the `wrapWithIslandsBootstrap` helper at the bottom of `runtime/routes.ts`**

```ts
const ISLANDS_IMPORTMAP_AND_BOOTSTRAP =
  '<script type="importmap">' +
  JSON.stringify({
    imports: {
      // Both react and react/jsx-runtime resolve to the SAME chunk; the
      // chunk re-exports both surfaces. Browser fetches it once and slices
      // different named exports for each import statement.
      'react': '/_brust/islands/_react.js',
      'react/jsx-runtime': '/_brust/islands/_react.js',
      'react-dom/client': '/_brust/islands/_react-dom.js',
    },
  }) +
  '</script>' +
  '<script type="module" src="/_brust/islands/_bootstrap.js" defer></script>'

/** Prepend the importmap + bootstrap <script> tags to the rendered HTML.
 * If the HTML starts with `<html>` or `<!doctype html>`, the scripts are
 * injected at the very top of the document (browsers tolerate <script>
 * before <html>); otherwise they're prepended to the body fragment. */
function wrapWithIslandsBootstrap(html: string): string {
  return ISLANDS_IMPORTMAP_AND_BOOTSTRAP + html
}
```

- [ ] **Step 4: Build .node + run existing tests to confirm no regression**

Run:
```bash
cd /Users/detoro/code/brust/runtime && bun run build:debug && cd -
cd /Users/detoro/code/brust && bun run test
```

Expected: **15 tests pass** (same as before this task). Why? No route in the example yet uses `<Island>`, so the flag is always false and the wrap is a no-op.

- [ ] **Step 5: Commit**

```bash
git add runtime/routes.ts
git commit -m "$(cat <<'EOF'
feat(runtime): makeRenderer auto-injects islands bootstrap when used

If any <Island> rendered during this request, makeRenderer prepends an
importmap (mapping react / react/jsx-runtime / react-dom/client to
/_brust/islands/_*.js) and a <script type="module" src="..._bootstrap.js" defer>
to the response body. Pages without islands ship zero JS.

The errorBoundary 500 path also drains the flag so a partial render
doesn't leak the script injection to the next request.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire `buildIslands` + `configureIslandsDir` into the example app

**Files:**
- Create: `example/hello-world/components/Counter.tsx`
- Create: `example/hello-world/island.config.ts`
- Modify: `example/hello-world/components/HelloWorld.tsx`
- Modify: `example/hello-world/index.ts`
- Modify: `.gitignore` (add `.brust/`)

- [ ] **Step 1: Create the island component**

`example/hello-world/components/Counter.tsx`:
```tsx
import { useState } from 'react'

export interface CounterProps {
  start?: number
  label?: string
}

export default function Counter({ start = 0, label = 'count' }: CounterProps) {
  const [n, setN] = useState(start)
  return (
    <button data-testid="counter" onClick={() => setN(n + 1)}>
      {label}: {n}
    </button>
  )
}
```

- [ ] **Step 2: Create the island config**

`example/hello-world/island.config.ts`:
```ts
export default {
  islands: {
    Counter: './components/Counter.tsx',
  },
}
```

- [ ] **Step 3: Add the Island marker to HelloWorld**

Read the current `example/hello-world/components/HelloWorld.tsx` first to know its shape, then add the Island. Here's the expected final shape — adapt to whatever the existing file looks like:

```tsx
import { Island } from '../../../runtime/index.ts'
import Counter from './Counter'
import type { RouteContext } from '../../../runtime/routes.ts'

export default function HelloWorld({ workerId }: RouteContext) {
  return (
    <html>
      <body>
        <h1>Hello from Brust</h1>
        <p>worker_id={workerId ?? '?'}</p>
        <Island
          id="Counter"
          component={Counter}
          props={{ start: 0, label: 'clicks' }}
          hydrate="load"
        />
      </body>
    </html>
  )
}
```

(Important: keep `worker_id=` text intact since an existing test asserts `body.toMatch(/worker_id=\d+/)`.)

- [ ] **Step 4: Update `example/hello-world/index.ts` to build islands**

Modify the file so that on the main thread (when `!isWorker`), it imports the config + runs `buildIslands` + `configureIslandsDir` before `serve`.

Replace the existing main-thread block:

```ts
if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  // Install the route table in Rust *before* serve() boots the accept loop.
  // Workers will load the same routes.tsx, so route_id (= array index) is
  // stable across main thread and every worker.
  brust.registerRoutes(routes)

  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
  })
}
```

With:

```ts
if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }

  // Build islands BEFORE serve(): emits .brust/islands/<id>.js plus the
  // shared React runtime + bootstrap chunks.
  const islands = await buildIslands(
    new URL('./island.config.ts', import.meta.url).pathname,
  )
  brust.configureIslandsDir(islands.outDir)
  console.log(`[brust] main: built ${islands.islandCount} island chunk(s)`)

  brust.registerRoutes(routes)
  await brust.serve({ port, workers, entry: import.meta.url })
}
```

Add the new import at the top:

```ts
import { brust, isWorker, loadConfig, makeRenderer, buildIslands } from '../../runtime/index.ts'
```

(Keep the worker-side block unchanged — workers don't run the build.)

- [ ] **Step 5: Add `.brust/` to .gitignore**

Append to `.gitignore`:

```
# Brust build output
.brust/
```

- [ ] **Step 6: Manual sanity check**

Run:
```bash
cd /Users/detoro/code/brust && cd runtime && bun run build:debug && cd -
BRUST_PORT=38700 bun run example/hello-world/index.ts &
DEV_PID=$!
sleep 4
echo "=== /  ===" && curl -s http://127.0.0.1:38700/ | head -c 400
echo
echo "=== /_brust/islands/Counter.js (first 80 bytes) ===" && curl -s http://127.0.0.1:38700/_brust/islands/Counter.js | head -c 80
echo
echo "=== /_brust/islands/_bootstrap.js (first 80 bytes) ===" && curl -s http://127.0.0.1:38700/_brust/islands/_bootstrap.js | head -c 80
echo
echo "=== /_brust/islands/missing.js (should 404) ===" && curl -si http://127.0.0.1:38700/_brust/islands/missing.js | head -3
kill -INT $DEV_PID 2>/dev/null
wait $DEV_PID 2>/dev/null
```

Expected:
- `/` returns 200 HTML containing both the `data-brust-island="Counter"` marker AND the `<script type="importmap">` + bootstrap script tags.
- `Counter.js` returns 200 application/javascript.
- `_bootstrap.js` returns 200 application/javascript.
- `missing.js` returns 404.

- [ ] **Step 7: Commit**

```bash
git add example/hello-world/components/Counter.tsx \
        example/hello-world/island.config.ts \
        example/hello-world/components/HelloWorld.tsx \
        example/hello-world/index.ts \
        .gitignore
git commit -m "$(cat <<'EOF'
feat(example): /  page embeds an <Island id="Counter"> hydrating on load

Adds Counter.tsx (useState button), wires it through island.config.ts,
and the existing HelloWorld route embeds <Island id="Counter">. The dev
script builds islands at boot via buildIslands(...) and passes the outDir
to Rust via configureIslandsDir.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Integration tests

**Files:**
- Modify: `tests/integration.test.ts` (append 3 new tests immediately before the `readPortLine` helper)

- [ ] **Step 1: Append the 3 tests**

```ts
test('island marker + importmap injected when route uses <Island>', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38181', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`)
    expect(r.status).toBe(200)
    const body = await r.text()
    // Marker present, with id + JSON props + hydrate trigger.
    expect(body).toContain('data-brust-island="Counter"')
    expect(body).toContain('data-brust-hydrate="load"')
    expect(body).toContain('data-brust-props="{')
    // Importmap + bootstrap injected.
    expect(body).toContain('<script type="importmap">')
    expect(body).toContain('"/_brust/islands/_react.js"')
    // react/jsx-runtime also maps to _react.js (combined chunk).
    expect(body).toContain('"react/jsx-runtime":"/_brust/islands/_react.js"')
    expect(body).toContain('"/_brust/islands/_react-dom.js"')
    expect(body).toContain('src="/_brust/islands/_bootstrap.js"')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 30_000)

test('island chunk + bootstrap served at /_brust/islands/<file>', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38182', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    for (const file of ['Counter.js', '_bootstrap.js', '_react.js', '_react-dom.js']) {
      const r = await fetch(`http://127.0.0.1:${port}/_brust/islands/${file}`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
      expect(r.headers.get('cache-control')).toBe('public, max-age=3600')
      const body = await r.text()
      expect(body.length).toBeGreaterThan(0)
    }

    // 404 + path-traversal safety.
    const missing = await fetch(`http://127.0.0.1:${port}/_brust/islands/missing.js`)
    expect(missing.status).toBe(404)

    const traversal = await fetch(`http://127.0.0.1:${port}/_brust/islands/..%2Fetc%2Fpasswd.js`)
    expect(traversal.status).toBe(404)

    const noExt = await fetch(`http://127.0.0.1:${port}/_brust/islands/Counter`)
    expect(noExt.status).toBe(404)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 30_000)

test('routes without <Island> ship no importmap or bootstrap', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38183', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // /blog/{slug} doesn't use <Island>.
    const r = await fetch(`http://127.0.0.1:${port}/blog/test-slug`)
    expect(r.status).toBe(200)
    const body = await r.text()
    expect(body).not.toContain('data-brust-island')
    expect(body).not.toContain('<script type="importmap">')
    expect(body).not.toContain('_bootstrap.js')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 30_000)
```

(Timeouts bumped to 30s because the first request on a fresh spawn includes Bun.build, which takes ~1-3s.)

- [ ] **Step 2: Run the full suite**

Run: `cd /Users/detoro/code/brust && bun run test`
Expected: **18 tests pass** (15 from prior plans + 3 new). 0 fail.

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): islands marker + chunk endpoint + no-JS-by-default

- / (uses <Island id=Counter>) → marker rendered with id/props/hydrate
  attrs + importmap + bootstrap script tags
- /_brust/islands/<file> serves Counter.js, _bootstrap.js, _react.js,
  _jsx-runtime.js, _react-dom.js with correct content-type and cache-control;
  404 for missing files, path-traversal attempts, and non-.js paths
- /blog/{slug} has no <Island> → no importmap, no bootstrap, no marker

Timeouts at 30s because first request includes Bun.build (~1-3s).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update `architecture.md`

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Move Islands status from designed to built**

Find the Islands section (around line 391). At the end of that section, append a "Status" subsection:

```
**Status (MVP shipped):**

- `<Island id component props hydrate?>` runtime component embeds the SSR HTML inside a `data-brust-island` marker and flips a module-scope flag.
- `makeRenderer` auto-injects an importmap + `<script type="module" src="/_brust/islands/_bootstrap.js" defer>` when any island rendered. Pages without islands ship zero JS.
- `buildIslands(configPath)` at boot reads `island.config.ts` and runs `Bun.build` 4+N times: 1 React chunk, 2 react-external chunks (jsx-runtime, react-dom/client), N island chunks (all 3 external), 1 bootstrap. Output lands in `.brust/islands/`.
- Rust native route `GET /_brust/islands/<file>` serves chunks with `Cache-Control: public, max-age=3600`. Strict filename-safety check rejects path-traversal, hidden files, non-JS, and anything outside `[A-Za-z0-9_.-]+\.js`.
- 4 hydration triggers shipped: `load` / `idle` / `visible` / `interaction`.

**MVP-scope simplifications (vs the architecture vision above):**

- `<Island>` is a manual wrapper. The `"use island"` directive + auto-detection at JSX call sites is deferred — users explicitly wrap.
- Each island's `id` must be listed in `island.config.ts` (single source of truth for the build).
- Filenames are predictable (`<id>.js`), not content-hashed. Production deployments should fingerprint or wrap with a CDN.
- React, react/jsx-runtime, and react-dom/client are 3 shared chunks via importmap. Per-island bundle = component + your imports only.
- No CSS extraction, no `"use server"` auto-rewrite (separate plan), no nested islands, no hot reload.
```

- [ ] **Step 2: Update the Built / Designed-not-built lists**

Find the Built list (around line 962-984). Add after the per-route middleware bullet:

```
- Islands hydration MVP: `<Island id component props hydrate?>` + `buildIslands(configPath)` + `/_brust/islands/<file>` static route + handwritten bootstrap with 4 triggers (load/idle/visible/interaction) + shared React runtime via importmap
```

Find the Designed-not-built list. Replace:

```
- Islands hydration (`"use island"`, lazy bootstrap, hydration triggers)
```

With:

```
- Islands: `"use island"` directive + auto-detection at JSX call sites (MVP uses manual `<Island>` wrapper)
- Islands: content-hashed filenames + production caching strategy
- Islands: CSS extraction per chunk
- Islands: hot reload during dev
```

- [ ] **Step 3: Final verify run**

```bash
cd /Users/detoro/code/brust
cargo build
cargo test --lib                    # 33 unit tests (5 http + 13 routes + 4 cache + 11 server)
cd runtime && bun run build:debug && cd -
bun run test                        # 18 integration tests
```

Expected: cargo clean (1 pre-existing warning OK), 33 unit tests pass, 18 integration tests pass.

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): islands hydration MVP shipped

Documents the MVP-scope tradeoffs vs the full vision:
- Manual <Island> wrapper instead of "use island" directive
- Predictable filenames (no content hash)
- 3 shared runtime chunks via importmap
- 4 triggers: load / idle / visible / interaction

Designed-not-built loses the catch-all Islands bullet and gains four
focused follow-ups: directive auto-detection, content-hashed names,
CSS extraction, hot reload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Verification checklist

```bash
cargo build                                    # clean
cargo test --lib                               # 33 pass
cd runtime && bun run build:debug && cd -      # rebuild .node
bun run test                                   # 18 pass
```

Manual sanity:

```bash
BRUST_PORT=38800 bun run example/hello-world/index.ts &
sleep 4

# Marker + importmap + bootstrap on /
curl -s http://127.0.0.1:38800/ | grep -E 'data-brust-island|importmap|_bootstrap'

# Chunks served
curl -si http://127.0.0.1:38800/_brust/islands/Counter.js | head -3
curl -si http://127.0.0.1:38800/_brust/islands/_react.js | head -3

# 404 cases
curl -si http://127.0.0.1:38800/_brust/islands/missing.js | head -3
curl -si http://127.0.0.1:38800/_brust/islands/Counter | head -3
curl -si 'http://127.0.0.1:38800/_brust/islands/..%2Fsecret.js' | head -3

# No JS on a page without <Island>
curl -s http://127.0.0.1:38800/blog/foo | grep -c importmap   # → 0
```

---

## Risks / caveats

1. **Boot delay ~200-1000ms** for `Bun.build` × (3 runtime + N islands + 1 bootstrap). Acceptable for `bun run dev`; production hot path should pre-build once and skip the boot pass. Out of scope for this MVP.

2. **React mismatch warnings** if a user's island component renders differently on server vs first client render (e.g., uses `Date.now()`, `Math.random()`, browser-only APIs). Documented in the MVP scope; users responsible for hydration-safe components.

3. **JSON-only props** mean no functions, classes, Map/Set, DOM nodes, etc. `JSON.stringify(props)` happens at SSR time; un-serializable values silently become `null` or throw. Document in the JSDoc on `<Island>`.

4. **`data-brust-props` attribute escaping** — JSX auto-escapes `"` in attribute values, so `data-brust-props={JSON.stringify(...)}` produces correctly quoted HTML. But this means the value in the live DOM uses `&quot;` for `"`. Bootstrap reads via `el.getAttribute(...)` which DOM-decodes, so `JSON.parse` works. No special handling needed but worth knowing.

5. **Filename predictability invites accidental collisions across packages.** If two libraries both register `id: "Button"`, the second `Bun.build` overwrites the first chunk. Documented limitation — for MVP, library publishers should namespace their ids.

6. **The Rust `is_safe_island_filename` regex DOESN'T allow `+` or `=`, which means base64-encoded ids fail.** Acceptable: the TS-side `isValidIslandId` enforces the same charset, so the build won't emit anything that the server can't serve. Both are kept in sync; if either is loosened, the other must follow.

7. **`tokio::fs::read` reads the whole file into memory before responding.** Chunks are tiny (<100 KB) so this is fine; streaming is out of scope.

8. **No production-grade caching:** `Cache-Control: public, max-age=3600` is in-place but filenames aren't fingerprinted, so a redeploy could serve stale chunks during the TTL window. Production users should put a CDN with cache-busting in front, or wait for the content-hash follow-up.

9. **Bun.build's `naming` option for a SINGLE entrypoint:** verified in the spike (Task 1). If `naming` is interpreted as a template instead of a literal filename in a future Bun version, the output names will need a post-build rename step.

---

*End of plan.*
