# Tailwind v4 CSS Pipeline — Design

**Date:** 2026-05-27
**Status:** Designed, awaiting plan
**Scope:** Sub-project D in the build-pipeline roadmap. First-class Tailwind v4 support — `app.css` source-of-truth, compiled at build time and (in dev) at boot time, served from `/_brust/css/<file>`, `<link>` auto-injected by the SSR renderer.

---

## Goal

Make a Brust app styleable with Tailwind v4 via the project conventions already shipped (a single `app.css` at the entry directory). The CSS pipeline plugs into both phases of the build/run split established in `2026-05-26-build-cli-and-dist-pipeline-design.md`:

- **Dev mode** (`bun run example/.../index.ts`) — `brust.run()` compiles `app.css` on boot to `.brust/css/`, mirrors the existing `buildIslands` behavior. No watch / no HMR.
- **Build mode** (`brust build`) — pipeline step compiles `app.css` to `<outDir>/css/app.css`. `bun run dist/index.js` serves the prebuilt artifact, no recompilation.

The first browser request gets the compiled stylesheet via a new Rust route `GET /_brust/css/<file>`, mirroring the existing `/_brust/islands/<file>` plumbing exactly. The SSR renderer auto-injects `<link rel="stylesheet" href="/_brust/css/app.css">` before `</head>` of the first chunk.

---

## Non-goals

- Component-level CSS imports (`import './foo.css'`, CSS Modules). Sub-project E.
- Watch / HMR / `brust dev`. Separate sub-project.
- Sourcemaps. Future polish.
- Multiple CSS entry files. MVP supports exactly one (`app.css`).
- PostCSS plugins outside the Tailwind v4 ecosystem. Tailwind v4 exposes `@plugin` directives in CSS for its own plugin protocol — use that.
- Content-hashed filenames + manifest. MVP relies on `Cache-Control: max-age=3600` for caching; hashed names are a future deploy-time enhancement.
- Auto-injecting `@source` globs. User writes them in CSS per Tailwind v4 docs.

---

## High-level architecture

```
DEV MODE: brust.run() in <entry>
─────────────────────────────────────────
  scanRoot/app.css exists?
    yes → buildCss(scanRoot/app.css, .brust/css/)
          configureCssDir(.brust/css/)        // Rust: where to serve from
          configureCssEnabled(['/_brust/css/app.css'])  // JS: renderer hrefs
    no  → no-op
  ... (rest of brust.run unchanged: islands, MCP, routes, serve) ...


BUILD MODE: brust build
─────────────────────────────────────────
  1. clobber outDir                          (unchanged)
  2. scanActions                             (unchanged)
  3. buildIslands if island.config.ts        (unchanged)
  4. buildMcpManifest if routes.tsx          (unchanged)
  4.5 NEW: buildCss if entryDir/app.css
        → outDir/css/app.css
  5. write _actions-prebuilt.ts              (unchanged)
  6. Bun.build server bundle                 (unchanged — CSS not in JS bundle)
  7. copy native binary                      (unchanged)


PREBUILT RUNTIME (bun run dist/index.js):
─────────────────────────────────────────
  brust.run() with BRUST_PREBUILT=1:
    if existsSync(<distDir>/css):
      configureCssDir(<distDir>/css)
      configureCssEnabled(['/_brust/css/app.css'])
    skip buildCss


REQUEST PATH (both modes):
─────────────────────────────────────────
  GET /_brust/css/<file>
    Rust: safe-filename check + read from current_css_dir() + 200/404
          Content-Type: text/css; charset=utf-8
          Cache-Control: public, max-age=3600

  GET / (any SSR route)
    Renderer first chunk: injectCssLink(body, getCssHrefs())
      ├─ scan for </head> (case-insensitive)
      ├─ splice <link rel="stylesheet" href="..."> tags before it
      └─ if </head> absent: console.warn once, return body unchanged
```

---

## Configuration

### Discovery (convention)

`<scanRoot>/app.css` at the entry directory. No explicit option; mirrors the `island.config.ts` discovery pattern. `scanRoot` defaults to `dirname(entry)` for `brust.run()` calls; in `brust build` it's `dirname(entry-arg)`.

If the file is missing, the entire CSS pipeline is skipped (`configureCssEnabled` is never called → no `<link>` injection → no Rust route handler hit, returns 404 if probed). The app keeps working with whatever styling it has otherwise.

### Tailwind v4 CSS-first config

The user writes everything in `app.css`:

```css
@import "tailwindcss";
@source "./**/*.{tsx,ts,jsx,js}";

@theme {
  --color-brand: #8a3324;
}

/* component layer, custom utilities, @plugin … etc */
```

Brust does NOT inject `@source` globs, theme variables, or anything else. The CSS file is the entire Tailwind contract.

---

## CSS build

### `runtime/css/build.ts`

```ts
import { Compiler } from '@tailwindcss/node'
import path from 'node:path'

export interface BuildCssOptions {
  /** Absolute path to the source CSS file (typically <scanRoot>/app.css). */
  entry: string
  /** Absolute path to the output directory. Created if missing. */
  outDir: string
}

export interface CssBuildResult {
  outDir: string
  files: string[]  // ['app.css']
}

export async function buildCss(opts: BuildCssOptions): Promise<CssBuildResult> {
  // 1. mkdir -p outDir
  // 2. Read source CSS
  // 3. const compiler = await Compiler.compile({ base: dirname(entry), ... })
  // 4. const css = compiler.build(sourceCss)
  // 5. Bun.write(path.join(outDir, 'app.css'), css)
  // 6. return { outDir, files: ['app.css'] }
}
```

The Tailwind v4 programmatic API (`@tailwindcss/node` package) is the source of truth. The plan picks the exact Compiler API (Tailwind v4 is settling; the import path/`compile` vs `Compiler` is verified during implementation).

### Where it runs

| Mode | Caller | Outcome |
|---|---|---|
| Dev (`brust.run`) | `runtime/index.ts::run()` | Writes to `.brust/css/app.css` (alongside `.brust/islands/`). Same dev convention. |
| Build (`brust build`) | `runtime/cli/build.ts::runBuild()` step 4.5 | Writes to `<outDir>/css/app.css`. |
| Prebuilt (`bun run dist/index.js`) | n/a | `brust.run()` detects `BRUST_PREBUILT=1` and skips. |

---

## Rust: `/_brust/css/<file>` route

Mirror `/_brust/islands/<file>` exactly:

```rust
// src/server.rs
if let Some(file) = path.strip_prefix("/_brust/css/") {
    let file = file.split('?').next().unwrap_or(file);
    if !is_safe_css_filename(file) {
        let _ = s.write_all(http::error_404()).await;
        continue;
    }
    let dir = match current_css_dir() {
        Some(d) => d,
        None => { let _ = s.write_all(http::error_404()).await; continue; }
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
                "text/css; charset=utf-8",
                &extra,
                bytes,
            );
            // … write_all, continue …
        }
        Err(_) => { /* 404 */ }
    }
}
```

### `is_safe_css_filename(name: &str) -> bool`

Mirror `is_safe_island_filename`: regex `^[A-Za-z0-9_.-]+\.css$`. No `..`, no `/`. Rejects anything with multiple dots in places that could form `..` traversal.

### Global dir state

```rust
// src/lib.rs or wherever CSS_DIR lives (mirror ISLANDS_DIR)
static CSS_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

#[napi]
pub fn configure_css_dir(dir: String) {
    *CSS_DIR.write().unwrap() = Some(PathBuf::from(dir));
}

pub fn current_css_dir() -> Option<PathBuf> {
    CSS_DIR.read().unwrap().clone()
}
```

Total Rust addition: one route branch, one global, one napi binding, one filename validator + tests. ~40 LOC.

---

## SSR `<link>` injection

### Strategy: first-chunk-only rewrite

React's `renderToPipeableStream` flushes the full document shell (including `<head>…</head>`) as one synchronous unit on `onShellReady`. By the time we assemble the first chunk on the renderer side, `</head>` is in there. Subsequent chunks (Suspense-resolved data) come after `<body>` and don't need rewriting.

Both renderer paths assemble a first chunk:
- **Buffering path** (`renderBranchStreaming` _final) — `concatBuffers(parts, islandsUsed)` produces the entire body. Run `injectCssLink` on it.
- **Streaming path** — `concatBuffers(buffer, true)` produces `flushed` (the shell). Run `injectCssLink` on `flushed` before `encodeFirstChunk`.

### `injectCssLink(body: Uint8Array, hrefs: string[]): Uint8Array`

Lives in `runtime/render/stream.ts` (or a sibling file).

```ts
// Pseudo-impl:
//   if hrefs.length === 0 return body
//   find first byte position of `</head>` (case-insensitive — '</HEAD>' also accepted)
//     using a byte-level search that handles ASCII case folding only
//   if not found:
//     warnOnce('[brust] css: no </head> in first chunk; <link> not injected')
//     return body
//   const tags = hrefs.map((h) => `<link rel="stylesheet" href="${h}">`).join('')
//   const tagsBytes = encoder.encode(tags)
//   return Uint8Array of (body[0..pos] + tagsBytes + body[pos..])
```

`warnOnce` is a module-scope `let warned = false` flag. We warn at most once per process so a misconfigured Layout doesn't flood logs.

### JS-side `configureCssEnabled` / `getCssHrefs`

New module `runtime/css.ts`:

```ts
let cssHrefs: string[] = []

export function configureCssEnabled(hrefs: string[]): void {
  cssHrefs = hrefs.slice()
}

export function getCssHrefs(): string[] {
  return cssHrefs
}
```

Module-scope, per-worker (workers re-execute the bundle so each gets its own copy — same pattern as the islands flag).

### Wiring into renderer

`renderBranchStreaming` reads `getCssHrefs()` once at request time and applies `injectCssLink` in both paths. No new function arg — the renderer reads module state, consistent with how `consumeIslandUsedFlag` works today.

---

## Component changes

| New / Edit | File | Purpose |
|---|---|---|
| **New** | `runtime/css/build.ts` | `buildCss({ entry, outDir })`. Programmatic `@tailwindcss/node` Compiler invocation. Writes `outDir/app.css`. |
| **New** | `runtime/css/build.test.ts` | Unit: a minimal `app.css` + a `.tsx` referencing `bg-red-500` → compiled output contains `.bg-red-500{`. |
| **New** | `runtime/css.ts` | Module-scope `configureCssEnabled` / `getCssHrefs`. |
| **Edit** | `runtime/render/stream.ts` | Add `injectCssLink(body, hrefs)`; call it from buffering `_final` and streaming header-chunk paths. |
| **New** | `runtime/render/inject-css-link.test.ts` | Pure-function tests for `injectCssLink` — covered cases listed in Testing section. |
| **Edit** | `runtime/index.ts::brust.run()` | Detect CSS config in BOTH main and worker branches. Main+dev: `buildCss` + `configureCssDir('.brust/css')` + `configureCssEnabled(['/_brust/css/app.css'])`. Main+prebuilt: `existsSync(<distDir>/css)` → `configureCssDir(<distDir>/css)` + `configureCssEnabled(...)`. Worker (any mode): `existsSync` the same path the main would and call `configureCssEnabled` only. `configureCssDir` is main-only (Rust shared state) — workers skip it. |
| **Edit** | `runtime/index.ts` | Add `brust.configureCssDir(dir: string)` to the public surface, mirroring `configureIslandsDir`. `configureCssEnabled` stays internal to `runtime/css.ts` (consumed by renderer + `brust.run`; not part of the public API). |
| **Edit** | `runtime/index.d.ts` | Add the new napi binding `configureCssDir(dir: string): void`. |
| **Edit** | `runtime/cli/build.ts` | Step 4.5: `if (existsSync(entryDir/app.css)) await buildCss(...)`. Log line. |
| **New** | `src/lib.rs` napi binding `configure_css_dir(dir)` + `CSS_DIR` global. |
| **Edit** | `src/server.rs` | New `/_brust/css/<file>` route branch. |
| **New** | `src/server.rs` (or new mod) | `is_safe_css_filename` validator + unit tests. |
| **Edit** | `package.json` (root + `runtime/`) | Add `@tailwindcss/node` to runtime deps. |
| **Edit** | `example/hello-world/components/Layout.tsx` | Remove inline `<style>` block. |
| **New** | `example/hello-world/app.css` | `@import "tailwindcss"; @source "./**/*.{tsx,ts}"` + utility classes equivalent to current STYLES. |
| **Edit** | `example/hello-world/components/*.tsx` + `pages/*.tsx` | Migrate inline / Layout-driven styles → Tailwind utility classes. Limited blast radius; the example app's surface is small. |
| **New** | Extend `tests/cli-build.test.ts` | Integration cases for CSS pipeline (see Testing). |
| **Edit** | `architecture.md` | Mark Tailwind v4 as Built; describe `<scanRoot>/app.css` convention + `/_brust/css/` route. |

**Rust:** ~40 LOC.

---

## Error handling

| Failure | Where | Behavior |
|---|---|---|
| `app.css` syntax error / unknown `@import` | `buildCss` | Throw with Tailwind's verbatim diagnostic. Build mode → `process.exit(1)` + dump. Dev mode → entry process dies with stack. |
| `@tailwindcss/node` not installed | `buildCss` dynamic import | Throw `Cannot find module …` → wrap with hint to `bun install`. |
| `@source` glob matches nothing | Tailwind | Produces empty utility layer; valid CSS. Log info: `[brust] css: 0 utility classes generated; check @source globs`. |
| `</head>` missing in first chunk | `injectCssLink` | `warnOnce` to stderr. Return body unchanged. Page still renders, just unstyled. |
| `</head>` straddles streaming chunk boundary | `injectCssLink` | Same `warnOnce`. Practically impossible — React flushes the shell as one unit. |
| `GET /_brust/css/<file>` — path traversal / unsafe filename | Rust | 404. No log. |
| `GET /_brust/css/app.css` — `current_css_dir()` is `None` | Rust | 404. (Means CSS wasn't configured at this boot — app likely has no `app.css`.) |
| `GET /_brust/css/app.css` — file deleted between build and request | Rust | 404. Edge case; same handling as islands. |
| Tailwind compile slow | `buildCss` | No timeout. Build / dev boot is allowed to take as long as needed. Typical small app compiles <500ms. |
| Build mode: `buildCss` throws | `runBuild` | `process.exit(1)`. Don't continue to step 5+. dist may be partial; next build clobbers. |
| Prebuilt: `<distDir>/css/` missing | `brust.run()` prebuilt branch | Skip `configureCssEnabled` entirely. Same as no-CSS app. |
| Prebuilt: `<distDir>/css/` empty | `brust.run()` prebuilt branch | `configureCssEnabled` still set (filesystem check is on dir, not file). GET returns 404, browser falls back to unstyled. Log a startup warning. |

**Invariant:** the renderer NEVER throws over CSS state. A missing stylesheet is degraded, not broken.

---

## Backward compatibility

- Apps without `<scanRoot>/app.css` see zero behavior change. No new code paths touched.
- Dev mode (`bun run example/.../index.ts`) keeps working — even before the example migration, since the inline `<style>` in Layout.tsx is preserved until the migration commit.
- Existing tests pass unchanged. The example migration (inline styles → Tailwind) only affects visual output; no test asserts visual styles.
- `buildIslands` signature unchanged. `brust.run()` adds a new branch but doesn't refactor existing branches.

---

## Testing

### Unit: `runtime/css/build.test.ts`

Fixture: a `tmp` dir with `app.css` (`@import "tailwindcss"; @source "./foo.tsx";`) and `foo.tsx` that uses `bg-red-500`. Run `buildCss`:

- `out/app.css` exists
- contains `.bg-red-500{` (used class generated)
- does NOT contain `.bg-blue-999` (unused class skipped)
- does NOT contain `@source` (Tailwind strips its own directives)
- return value: `{ outDir, files: ['app.css'] }`

Negative: missing `@import "tailwindcss"` still compiles (no utilities). Malformed CSS throws Tailwind's diagnostic.

### Unit: `runtime/render/inject-css-link.test.ts`

Pure function, no React. Body is a `Uint8Array`:

- body contains `</head>` → `<link>` spliced exactly before it
- body contains `</HEAD>` → matched case-insensitively
- body has no `</head>` → returns unchanged; `warnOnce` fires
- empty `hrefs` → unchanged, no warn
- multiple `hrefs` → all `<link>` tags in declaration order, all before `</head>`
- UTF-8 multibyte content preceding `</head>` → byte offsets preserved
- output is `Uint8Array` (no `Buffer` leak)

### Integration: extend `tests/cli-build.test.ts`

After the existing `brust build + bun run` test sequence:

```ts
test('brust build emits dist/css/app.css with compiled Tailwind', async () => {
  expect(existsSync(`${distDir}/css/app.css`)).toBe(true)
  const css = await Bun.file(`${distDir}/css/app.css`).text()
  expect(css).toMatch(/\*,::before,::after/)  // Tailwind v4 base reset signature
  expect(css).toContain('.flex')              // utility actually used by example
})

test('GET /_brust/css/app.css serves with correct headers', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/app.css`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toMatch(/^text\/css/)
  expect(r.headers.get('cache-control')).toMatch(/max-age=3600/)
})

test('SSR HTML contains injected <link rel="stylesheet"> before </head>', async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  const linkIdx = html.indexOf('<link rel="stylesheet" href="/_brust/css/app.css">')
  const headEnd = html.indexOf('</head>')
  expect(linkIdx).toBeGreaterThan(-1)
  expect(linkIdx).toBeLessThan(headEnd)
})

test('GET /_brust/css/..%2Fetc%2Fpasswd is 404', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/..%2Fetc%2Fpasswd`)
  expect(r.status).toBe(404)
})
```

### Rust unit: `is_safe_css_filename`

Mirror the existing islands counterpart. Accept `app.css`, reject `..`, `/foo`, `app.js`, `app.css/`, empty, leading dot, etc.

### Real-browser smoke (Chrome MCP — non-negotiable, per session 9 + 10 lessons)

After `bun run /tmp/dist/index.js`:

1. Open `/` — verify a Tailwind utility class renders visually (background color, spacing). DevTools: `/_brust/css/app.css` 200, no FOUC perceivable.
2. SPA-nav Home → Blog → Profile — CSS persists, no flash, no console errors.
3. Counter island still hydrates + clicks work (regression check from prior sessions).
4. Force-reload `/_brust/css/app.css` directly — file loads, MIME type correct.

### Existing baselines after change

- `cargo test --lib` — was 93, expect 93 + ~3 (filename validator + dir set/get). Target: **96+**.
- `bun test runtime/` — was 103, expect 103 + ~9 (inject-css-link + buildCss). Target: **~112**.
- `bun test tests/` — was 73, expect 73 + 4 (new CSS cases in cli-build.test.ts). Target: **77**.

All existing tests must continue to pass.

---

## Documentation

- **`architecture.md`:**
  - "Designed, not built" list → remove `Tailwind v4` if present.
  - "Built" list → add: `Tailwind v4 — \`app.css\` convention, programmatic \`@tailwindcss/node\` compile, served at \`/_brust/css/\` with auto-injected \`<link>\``.
  - Brief routing section update to mention `/_brust/css/<file>`.
- **`example/hello-world/README.md`** — if a styling section exists, update to reference `app.css`. Otherwise add a single paragraph.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| `@tailwindcss/node` API surface still settling at v4 | Plan verifies the exact entry point (`Compiler.compile` vs `compile` vs an init/build pair) at implementation time. Spec commits to "programmatic; no shell subprocess." |
| Case-insensitive `</head>` matching adds complexity | Mitigated by limiting case folding to ASCII letters (`H`, `E`, `A`, `D`). React always emits lowercase, so the uppercase branch is defensive. |
| Example app migration breaks visual smoke for someone running the demo today | Migration is part of this sub-project, on the same commit chain. Reviewer + Chrome MCP smoke validate the new look matches intent. |
| Build adds runtime dep that pulls native binaries | `@tailwindcss/node` uses `@tailwindcss/oxide` (Rust-based). Cross-platform `.node` shipping is the same concern as our own native binary; Tailwind ships prebuilts on npm. Document in README that prod builds use the host platform's prebuilt; CI matrix concern. |
| `</head>` straddles a streaming chunk (theoretical) | Logged via `warnOnce`. If it ever fires, fix is a streaming-aware FSM, but React's renderer doesn't split the shell. |

---

## Out of scope (explicit list)

To prevent scope creep when writing the plan:

- Component-level CSS imports (`import './foo.css'`, CSS Modules) — sub-project E.
- Watch / HMR / `brust dev` — separate sub-project.
- Sourcemaps.
- Multiple CSS entry files.
- Content-hashed filenames + manifest.
- Auto-injecting `@source` globs.
- PostCSS plugins outside Tailwind's `@plugin` protocol.
- TLS, HTTP/2, graceful drain.
- Demo (`example/hello-world/README.md`) full rewrite — only the CSS section gets touched.
- `brust dev` / `brust new` / `brust invalidate` / `brust build --watch`.

---

## Acceptance criteria

The plan is done when all of the following hold:

1. `bun run example/hello-world/index.ts` (dev mode) boots, compiles `example/hello-world/app.css` to `.brust/css/app.css`, and serves `GET /_brust/css/app.css` with 200 + `text/css`.
2. The SSR HTML at `GET /` contains `<link rel="stylesheet" href="/_brust/css/app.css">` immediately before `</head>`.
3. `bun runtime/cli/index.ts build example/hello-world/index.ts --out-dir /tmp/dist` emits `/tmp/dist/css/app.css` alongside the existing bundle / islands / native artifacts.
4. `bun run /tmp/dist/index.js` boots, serves `/_brust/css/app.css` from `/tmp/dist/css/`, and SSR HTML still injects the `<link>`.
5. Real-browser Chrome MCP smoke: home page renders styled, SPA nav preserves styling, Counter island still hydrates and increments.
6. Baselines: Rust 96+ / Runtime 112+ / Integration 77 — all green.
7. An app without `app.css` (e.g. a minimal entry) boots identically to today; no `<link>` injected; `/_brust/css/*` returns 404; no warnings logged.
