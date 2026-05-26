# Build CLI + dist Pipeline — Design

**Date:** 2026-05-26
**Status:** Designed, awaiting plan
**Scope:** Foundation sub-project. No Tailwind, no component CSS imports, no dev/watch mode, no HMR — those are downstream sub-projects that ride on this.

---

## Goal

Split Brust into two clearly separated phases:

1. **Build** — one CLI command (`brust build`) emits a self-contained `./dist/` directory.
2. **Run** — `bun run ./dist/index.js` boots the pre-built server with no further build work.

Today Brust does both inside one process: `brust.run()` (called from the user's entry file) scans actions, builds islands, builds the MCP manifest, and then serves — every boot. That is fine for the example app but blocks any future build step that is too expensive to repeat on each restart (Tailwind compile, full CSS aggregation, server bundle minification) and prevents shipping a deploy artifact that does not need source files at runtime.

This spec adds the foundation. Subsequent sub-projects (Tailwind v4, component CSS imports, `brust dev`, `brust new`) plug additional build steps into the same pipeline without re-shaping the runtime.

---

## Non-goals

- Tailwind v4 support. Separate spec.
- Component-level CSS imports (`import './foo.css'`, CSS Modules). Separate spec.
- `brust dev` (watch + restart) or `brust dev --hmr`. Separate spec.
- `brust new` (project scaffolding).
- `brust invalidate` (cache CLI — distinct from the existing `POST /_brust/cache/invalidate` endpoint).
- Multi-platform `.node` artifacts in a single `dist/`. The build copies the *current* platform's binary only; cross-platform builds are a CI matrix concern not in scope here.
- `bun build --compile` single-binary output. The user explicitly asked for `bun run ./dist/index.js`, not a standalone binary.
- Custom TSX transformers, Bun plugins for `"use island"` auto-detection, server-fn client-side auto-rewrite. The build uses `Bun.build`'s default TSX loader.

---

## High-level architecture

```
PHASE 1: brust build
─────────────────────────────────────────────────────────────
$ bun x brust build [entry] [--out-dir dist]

  entry default = ./index.ts (resolved from cwd)
  out-dir default = ./dist

       ├─ rm -rf ./dist && mkdir -p ./dist
       │
       ├─ scanActions({ roots: [<entryDir>] })
       │      → { actions, sourceFiles }
       │      (same scanner as runtime; just runs at build time)
       │
       ├─ buildIslands(<entryDir>/island.config.ts, { outDir: ./dist/islands })
       │      → ./dist/islands/{_react.js, _react-dom.js, _bootstrap.js, <id>.js, …}
       │      (no shape change — only outDir override is new)
       │      skipped if island.config.ts is absent
       │
       ├─ buildMcpManifest({ routes, actions, sourceFiles, … })
       │      → writes ./dist/mcp-manifest.json
       │      skipped if routes.tsx is absent
       │
       ├─ Bun.build({
       │       entrypoints: [<entry>],
       │       outdir: ./dist,
       │       naming: 'index.js',
       │       target: 'bun',
       │       format: 'esm',
       │       minify: true,
       │       external: ['*.node'],   // .node modules cannot be bundled
       │       banner: PREBUILT_HEADER,
       │       plugins: [nativeShimPlugin], // see "Native binary" below
       │     })
       │      → ./dist/index.js
       │
       └─ copy runtime/index.<platform>-<arch>.node → ./dist/native/

PHASE 2: bun run ./dist/index.js
─────────────────────────────────────────────────────────────
Bun process executes ./dist/index.js.

  Header (injected by build):
       process.env.BRUST_PREBUILT = '1'
       process.env.BRUST_DIST_DIR = import.meta.dir

  Bundled user code calls brust.run({ routes, entry: import.meta.url }).

  brust.run() reads BRUST_PREBUILT and branches:
       ├─ skip buildIslands → configureIslandsDir(BRUST_DIST_DIR/islands)
       ├─ skip buildMcpManifest → load BRUST_DIST_DIR/mcp-manifest.json
       ├─ still runs scanActions (registers ids with Rust — module code is in
       │    the bundle but Rust needs the id list at boot)
       ├─ registerRoutes, registerSsePaths, registerWsPaths (unchanged)
       └─ serve() (unchanged)

  Workers spawn with new Worker(opts.entry) where opts.entry == import.meta.url
       of ./dist/index.js. The worker re-executes the same bundle file; the
       isWorker branch runs (same prebuilt detection).
```

---

## CLI

### Surface

```
brust build [entry] [--out-dir dir]
```

| Arg / flag | Default | Notes |
|---|---|---|
| `entry` (positional) | `./index.ts` (cwd) | Must exist. Resolved to absolute path. |
| `--out-dir <dir>` | `./dist` | Resolved relative to cwd. Cleared (`rm -rf`) before each build. |

No other flags in MVP. `minify`, `target`, `format` are fixed.

### Discovery

`package.json` gets:

```json
{
  "bin": { "brust": "./runtime/cli/index.ts" }
}
```

Bun executes `.ts` directly via the shebang `#!/usr/bin/env bun`. After `bun install` the user runs `bun x brust build` (or `bunx brust build`). The CLI file itself is a thin dispatcher:

```ts
// runtime/cli/index.ts
#!/usr/bin/env bun
const [, , subcommand, ...rest] = process.argv
switch (subcommand) {
  case 'build': await (await import('./build.ts')).runBuild(rest); break
  default:      console.error(`unknown command: ${subcommand}`); process.exit(1)
}
```

`runtime/cli/build.ts` orchestrates the four build steps.

### Errors

| Case | Behavior |
|---|---|
| entry file missing | exit 1, message: `no entry file at <path>; pass a path or create ./index.ts` |
| `Bun.build` returns `success: false` | exit 1, dump `result.logs` (same pattern as the existing `buildIslands` helper) |
| `buildIslands` throws (invalid id, etc.) | exit 1, error bubbled |
| `buildMcpManifest` throws | exit 1, error bubbled |
| `runtime/index.<platform>-<arch>.node` missing | exit 1, message: `no native binary for <triple>; run \`bun --filter runtime run build\` first` |
| `./dist` exists and rm fails (permissions) | exit 1, native error message |

No partial state: the build clobbers `dist` before any step writes. If a step fails the dist may be incomplete, but the next run clobbers and retries.

---

## Output layout

```
dist/
├── index.js                              # server bundle (entry → bundled)
├── mcp-manifest.json                     # pre-built MCP manifest (omitted if no routes.tsx)
├── islands/                              # pre-built island chunks (omitted if no island.config.ts)
│   ├── _react.js
│   ├── _react-dom.js
│   ├── _bootstrap.js
│   └── <id>.js                           # one per island in island.config.ts
└── native/
    └── index.<platform>-<arch>.node      # napi-rs cdylib for the build host's triple
```

Nothing else. No source maps in MVP (Bun.build default is no sourcemap). No `package.json` copied — runtime dependencies (`react`, `react-dom`) are bundled into `index.js` per Bun.build's default behavior.

---

## Prebuilt-mode detection

### Mechanism

The build step prepends a banner to the bundle output via Bun.build's `banner` option:

```js
process.env.BRUST_PREBUILT = '1'
process.env.BRUST_DIST_DIR = import.meta.dir
```

`import.meta.dir` resolves at execution time to the directory containing the bundle (`./dist`). This works for both the main process and any worker spawned with `new Worker(import.meta.url)` because each worker re-executes the bundle from the same path.

### Read site

`runtime/index.ts::brust.run()` checks `process.env.BRUST_PREBUILT === '1'` once at function entry and branches:

```ts
async run(opts: ...): Promise<void> {
  const prebuilt = process.env.BRUST_PREBUILT === '1'
  const distDir  = process.env.BRUST_DIST_DIR // present only in prebuilt mode

  // scanActions runs in both modes: registers action ids with Rust.
  // In prebuilt mode, the action *modules* are already in the bundle —
  // scanActions still walks the source roots to enumerate ids. Since
  // source files are not shipped to dist, scanActions in prebuilt mode
  // needs an alternate id source.
  //
  // Solution: write actions.json next to mcp-manifest.json at build time
  // and read it in prebuilt mode. (See "Action id manifest" below.)
  const actions = prebuilt
    ? await loadPrebuiltActions(distDir!)
    : (await this.scanActions({ roots: [scanRoot] })).actions

  if (!isWorker) {
    if (!prebuilt) {
      // existing flow: buildIslands + buildMcpManifest
    } else {
      // prebuilt mode
      this.configureIslandsDir(path.join(distDir!, 'islands'))
      // mcp manifest already on disk, read it instead of extracting
    }
    // routes/sse/ws registration + serve() — unchanged
  } else {
    // worker — same prebuilt check for manifest load path
  }
}
```

### Action id manifest

`brust.scanActions()` walks the filesystem to find `'use server'` files. After bundling, those files no longer exist at the original paths — Bun has inlined them into `dist/index.js`. So the build step calls `scanActions` once, writes the resulting `actions: ActionDef[]` to `dist/actions.json` (just the ids; modules are in the bundle), and the runtime reads that list in prebuilt mode instead of re-walking.

The ActionDef object today carries `{ id, fn, middleware }`. In prebuilt mode, the `fn` and `middleware` references come from the bundled imports — but the *list* of which ids exist is what `registerActionsInternal` needs. So `actions.json` contains just `string[]` of ids; the bundled code rebuilds the `ActionDef[]` array by re-importing the same modules. The simplest approach: in prebuilt mode, `scanActions` substitutes a no-op walk and instead returns ids from `actions.json` paired with the action handler functions that the bundled `'use server'` modules already registered into an in-memory registry as a side effect of being imported.

Today `scanActions` returns `ActionDef[]` whose `fn` field is the actual function imported from the source file. The bundle inlines those functions, but `scanActions` is what *finds* them. Two compatible mechanisms exist:

- **Option A — JSON manifest + dynamic re-import:** Build emits `dist/actions.json` with ids + original source-file paths. In prebuilt mode `brust.run()` reads the JSON and dynamic-imports each source path. Risk: resolving original paths against the bundled module graph is fragile.
- **Option B — Bun.build resolve plugin:** Build generates a tiny `dist/_actions-prebuilt.ts` that imports each discovered `'use server'` source file and re-exports an `ActionDef[]`. A Bun.build resolve plugin aliases `runtime/scan-actions.ts` to a prebuilt-aware variant that returns this pre-baked list when `BRUST_PREBUILT` is set. No post-build path resolution.

Option B is more build-time code but eliminates the runtime resolution problem.

**Decision deferred to the implementation plan.** The spec commits to: in prebuilt mode the action list comes from build-time discovery, never a runtime filesystem walk (source files do not ship to dist). The plan picks A or B based on actual Bun.build plugin behaviour.

### Worker entry

`brust.serve()` spawns workers with `new Worker(opts.entry)`. In dev mode `opts.entry` is the user's `index.ts` file URL. In prebuilt mode `opts.entry` is `import.meta.url` of the bundled `dist/index.js`. Bun's Worker constructor accepts the bundled file directly. No change needed in `serve()`.

---

## Native binary resolution

### Problem

`runtime/index.js` (generated by napi-rs) selects the platform binary at runtime:

```js
// napi-rs generated shim (excerpt)
const { platform, arch } = process
nativeBinding = require(`./index.${platform}-${arch}.node`)
```

Bun.build cannot bundle `.node` files. With `external: ['*.node']` the require call survives, but the relative path (`./index.darwin-arm64.node`) resolves relative to the bundle's location (`dist/index.js`), so it would look for `dist/index.darwin-arm64.node`, which is not where the build puts the binary.

### Solution

A Bun.build plugin (`runtime/cli/native-shim-plugin.ts`) intercepts `runtime/index.js` during bundling and replaces it with an inline shim:

```ts
// generated shim, inlined into dist/index.js
const { createRequire } = require('node:module')
const require_ = createRequire(import.meta.url)
const { platform, arch } = process
const binary = `index.${platform}-${arch}.node`
const path = require_('node:path').join(
  process.env.BRUST_DIST_DIR ?? import.meta.dir,
  'native',
  binary,
)
module.exports = require_(path)
```

The shim relies on `BRUST_DIST_DIR` which the banner sets first. `import.meta.dir` is the fallback; both resolve to `dist/`.

In dev mode (`bun run example/hello-world/index.ts`), `runtime/index.js` is read directly from `runtime/` and the plugin does not run — the file's existing relative `require('./index.<triple>.node')` works because `runtime/index.<triple>.node` is right there next to it. **No change for dev mode.**

### Platform mismatch

If the binary copied at build time does not match the runtime platform (e.g. built on macOS, deployed on Linux without rebuilding), the require throws with Node's standard "cannot find module" error. The shim catches and re-throws with a clearer message:

```
no native binary for <platform>-<arch> in <distDir>/native/.
Run `brust build` on the target platform, or build for multiple
platforms via your CI pipeline.
```

Multi-platform builds are a future concern.

---

## Component changes

| New / Edit | File | Purpose |
|---|---|---|
| **New** | `runtime/cli/index.ts` | CLI entry point with shebang. Dispatches `build` to `runtime/cli/build.ts`. |
| **New** | `runtime/cli/build.ts` | Orchestrates the four build steps. Exports `runBuild(args: string[])`. |
| **New** | `runtime/cli/native-shim-plugin.ts` | Bun.build plugin: intercept `runtime/index.js` → inline shim that resolves binary from `BRUST_DIST_DIR/native/`. |
| **Edit** | `runtime/islands/build.ts` | Add `options?: { outDir?: string }` to `buildIslands(configPath, options?)`. Default unchanged (`.brust/islands`). |
| **Edit** | `runtime/index.ts::brust.run()` | Branch on `process.env.BRUST_PREBUILT`. Skip buildIslands + buildMcpManifest; load pre-built manifest; use pre-built action list. |
| **Edit** | `runtime/index.d.ts` | No napi additions — all detection is JS-side env reads. |
| **Edit** | `package.json` | Add `"bin": { "brust": "./runtime/cli/index.ts" }`. |
| **New** | `tests/cli-build.test.ts` | Integration: build the example app to a temp dir, spawn `bun run dist/index.js`, smoke every major path. |

**Rust:** zero changes.

---

## Backward compatibility

- `bun run example/hello-world/index.ts` (today's dev flow) keeps working unchanged. `BRUST_PREBUILT` is not set, every existing code path runs.
- `buildIslands(configPath)` calls without the new `options` arg use the default `.brust/islands` outDir.
- The example app's `routes.tsx`, `actions/`, `island.config.ts`, etc. are unchanged.
- All existing tests pass without modification.

---

## Testing

### New: `tests/cli-build.test.ts`

A single integration test exercises the full build → run → request cycle. Pseudocode:

```ts
import { describe, test, expect, afterAll } from 'bun:test'
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const distDir = await mkdtemp(path.join(tmpdir(), 'brust-dist-'))
let proc: Bun.Subprocess

test('brust build emits a complete dist tree', async () => {
  await $`bun x brust build example/hello-world/index.ts --out-dir ${distDir}`

  expect(existsSync(`${distDir}/index.js`)).toBe(true)
  expect(existsSync(`${distDir}/mcp-manifest.json`)).toBe(true)
  expect(existsSync(`${distDir}/islands/_bootstrap.js`)).toBe(true)
  expect(existsSync(`${distDir}/islands/_react.js`)).toBe(true)
  expect(existsSync(`${distDir}/islands/Counter.js`)).toBe(true)

  const triple = `${process.platform}-${process.arch}`
  expect(existsSync(`${distDir}/native/index.${triple}.node`)).toBe(true)

  const bundle = await Bun.file(`${distDir}/index.js`).text()
  expect(bundle).toContain("process.env.BRUST_PREBUILT = '1'")
})

test('bun run dist/index.js serves all major paths', async () => {
  const port = 38280
  proc = Bun.spawn(['bun', 'run', `${distDir}/index.js`], {
    env: { ...process.env, BRUST_PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitForPort(port, 5000)

  // /ping (Rust-native)
  expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(200)
  // / (React SSR via SAB)
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
  // island chunk served from dist/islands/
  expect((await fetch(`http://127.0.0.1:${port}/_brust/islands/Counter.js`)).status).toBe(200)
  // MCP initialize roundtrip
  const mcp = await fetch(`http://127.0.0.1:${port}/_brust/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }),
  })
  expect(mcp.status).toBe(200)
})

test('brust build with missing entry exits 1', async () => {
  const result = await $`bun x brust build /no/such/file.ts`.nothrow()
  expect(result.exitCode).toBe(1)
})

afterAll(async () => {
  proc?.kill()
  await proc?.exited
  // tmp dir cleanup intentionally skipped; OS handles
})
```

### Manual smoke

After the test passes, manually:

1. `bun x brust build example/hello-world/index.ts --out-dir /tmp/brust-dist`
2. `BRUST_PORT=38281 bun run /tmp/brust-dist/index.js`
3. Open `http://127.0.0.1:38281/` in a real browser. Click through Home → Blog → Profile → Streaming. Verify Counter hydrates on `/`.

Session 9's lesson stands: unit tests miss real-browser bugs. The plan's verification step must include a Chrome MCP smoke before declaring done.

### Existing baselines

After the change:
- `cargo test --lib` — still 93 passed (zero Rust changes)
- `bun test runtime/` — still 103 passed (only `buildIslands` signature changes, with backward-compat default)
- `bun test tests/integration.test.ts` — still 70 passed (+ new file `cli-build.test.ts` with ~3 tests)

---

## Documentation

- **`architecture.md`:**
  - "Single-binary deploy" → rename to "Bundled deploy" and describe `brust build` → `bun run dist/index.js`.
  - "Project tooling" → mark `brust build` as Built; leave `brust new` / `brust dev` / `brust invalidate` as Designed-not-built.
  - "Status" section → add bullet: "`brust build` CLI emits `./dist/{index.js, islands/, mcp-manifest.json, native/}`; `bun run ./dist/index.js` boots without rebuild."
- **`example/hello-world/README.md`:** unchanged in this spec (per the scope question). A future demo-update sub-project can add a "Production build" section.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| Action manifest design (Option A vs B above) | Plan picks one and implements. Both are tractable; only the spec is non-committal because the right choice depends on Bun.build plugin ergonomics that need to be tested. |
| Native binary multi-platform | Out of scope. Documented as "build on target platform" in the error message. |
| Worker entry resolution in prebuilt mode | Verified mentally: `import.meta.url` of `dist/index.js` is passed to `new Worker()` and Bun loads it. Should Just Work but the integration test exercises this directly. |
| `Bun.build` `external: ['*.node']` glob support | If Bun.build does not accept glob, fall back to `external: ['./index.darwin-arm64.node', './index.linux-x64.node', …]` listed explicitly. Plan investigates first. |
| `brust.run()` env-flag branching adds complexity | Acceptable: it is a single env read at function entry; the existing flow is the default branch. Future cleanup if the dev vs prebuilt divergence grows. |

---

## Out of scope (explicit list)

To prevent scope creep when writing the plan:

- Tailwind v4 — its own spec, plugs into the build pipeline this spec creates.
- Component CSS imports (`import './foo.css'`, CSS Modules) — its own spec.
- `brust dev` / watch / HMR — its own spec.
- `brust new` (scaffold).
- `brust invalidate` (cache CLI).
- TLS, HTTP/2, graceful drain.
- Multi-platform native binary in one `dist/`.
- `bun build --compile` single-binary output.
- Custom TSX transformers, Bun plugins for `"use island"` auto-detection, server-fn client-side auto-rewrite.
- Sourcemaps.
- Demo (`example/hello-world`) README + scripts changes.

---

## Acceptance criteria

The plan is done when all of the following hold:

1. `bun x brust build example/hello-world/index.ts --out-dir /tmp/brust-dist` succeeds.
2. `/tmp/brust-dist/` contains `index.js`, `mcp-manifest.json`, `islands/<expected files>`, `native/index.<triple>.node`.
3. `bun run /tmp/brust-dist/index.js` boots, listens on the configured port, and serves `/ping`, `/`, `/blog/welcome`, `/_brust/islands/Counter.js`, `/_brust/mcp` (initialize) — all 200.
4. Manual Chrome MCP smoke on the prebuilt bundle: navigate Home → Blog → Profile, verify Counter hydrates.
5. `bun run example/hello-world/index.ts` (dev mode) still works identically to today.
6. Baselines: Rust 93 / Runtime 103 / Integration 70+new — all green.
