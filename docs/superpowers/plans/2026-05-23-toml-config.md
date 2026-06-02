# TOML Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a `brust.toml` file at startup, falling back cleanly when missing. Today the example app reads `BRUST_PORT` and `BRUST_WORKERS` from `process.env` only. After this plan, the same values can also be sourced from `brust.toml` (TOML wins over defaults, environment wins over TOML). The schema lands minimal: `[server]` + `[workers]`. The `[cache]` and `[build]` sections noted in `architecture.md` SConfiguration are explicitly deferred to the Cache and Build plans.

**Architecture:** A new `runtime/config.ts` exposes `loadConfig(cwd: string): Promise<BrustConfig>`. It reads `brust.toml` via `Bun.file(...)`, parses it with the `smol-toml` package (a 10 KB single-purpose TOML parser, MIT, no transitive deps), and merges three sources with explicit precedence: `defaults < toml < env`. `example/hello-world/index.ts` switches to call it. The `runtime/index.ts` facade is **not** changed — `brust.serve(opts)` keeps accepting an explicit `ServeOptions` object so library users who don't want a config file aren't forced into one.

**Tech Stack:** Bun 1.3, TypeScript 5.5, `smol-toml ^1.3.0` (new dev-time runtime dep). No Rust changes — config is resolved in JS before `brust.serve(opts)` is called.

**Spec source:** `architecture.md` SConfiguration:

> Today, env-only:
> - `BRUST_PORT` — default 3000
> - `BRUST_WORKERS` — default `floor(os.availableParallelism() * 1.8)`
> - `BRUST_WORKER_ID` — set per Worker; do not set manually
>
> Roadmap: `brust.toml` with `[server]`, `[workers]`, `[cache]`, `[build]` sections.

Handoff `architecture.md` reference and Tier 0 placement come from the S"Sub-project candidates" recommendation list.

---

## Context: precedence and discoverability

| Source | Precedence | Where it's read |
|---|---|---|
| Built-in defaults (port 3000, workers = `floor(availableParallelism * 1.8)`) | lowest | `runtime/config.ts` |
| `brust.toml` at CWD | middle | `Bun.file('brust.toml')` |
| `BRUST_PORT`, `BRUST_WORKERS` | highest | `process.env` |
| `BRUST_WORKER_ID` | (not user config — internal worker plumbing; do not surface in TOML) | unchanged in `runtime/index.ts` |

CLI flag (e.g. `brust --config=custom.toml`) is **out of scope** for this plan. We resolve `brust.toml` from `process.cwd()` only. When the CLI lands (separate plan), it will add the override.

Why `Bun.file()` instead of `import './brust.toml'`? Two reasons:

1. Static `import` would crash module evaluation if the file is missing, requiring a top-level `try`/`catch` anyway.
2. Bun's TOML import returns the parsed object but reads at module-graph build time, which means changes need a process restart even in dev mode. `Bun.file()` is read at call time and works the same way later when a `--watch` flag arrives.

### Files this plan touches

| File | Change |
|---|---|
| `package.json` | Add `smol-toml` to `dependencies`. Lockfile updates. |
| `runtime/config.ts` | Create. ~80 lines. Exports `loadConfig`, `BrustConfig`, and `BrustConfigError`. |
| `runtime/index.ts` | No functional change. Re-export `loadConfig` and `BrustConfig` for convenience. |
| `example/hello-world/index.ts` | Replace the inline env reads with a call to `loadConfig`. |
| `example/hello-world/brust.example.toml` | Create. A documented example file checked into git. |
| `.gitignore` | Add `brust.toml` (the user's local copy) but keep `brust.example.toml`. |
| `tests/integration.test.ts` | Add one new test that writes a temp `brust.toml`, runs the example, and asserts the port came from the file (not the default). The existing test (env-only path) stays as the env-override regression. |

`src/**` is **not** touched — the napi exports take `ServeOptions` as today. The TS facade composes it.

---

### Task 1: Baseline verification

**Files:** none modified

- [ ] **Step 1: Confirm cargo build + napi `.node` are current**

Run: `cargo build && cd runtime && bun run build:debug && cd -`
Expected: clean build, `runtime/index.darwin-arm64.node` regenerated.

- [ ] **Step 2: Run the integration test as baseline**

Run: `bun run test`
Expected: existing pass count (at least `1 pass`, more if other Tier-0 plans landed first). The `serves rendered html via worker pool` test uses `BRUST_PORT=38123`; that path must remain working after this plan because it documents the env-override behavior we want to preserve.

- [ ] **Step 3: Skip commit**

---

### Task 2: Add the `smol-toml` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `smol-toml` to `dependencies`**

Open `package.json`. Locate the `"dependencies"` block (currently lines 14-17):

```json
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
```

Add `smol-toml`. Result:

```json
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "smol-toml": "^1.3.1"
  },
```

(`smol-toml 1.3.1` exposes `parse(text: string): unknown` with no transitive deps. Newer minor versions are fine; pin to caret on `1.3.1` so a 2.x breaking release doesn't auto-upgrade.)

- [ ] **Step 2: Install**

Run: `bun install`
Expected: `bun.lock` updates. `bun.lock` should grow by a small block referencing `smol-toml`. No other packages move (verify with `git diff bun.lock | head -50`); if other packages moved versions, stop and investigate before committing the lockfile noise.

- [ ] **Step 3: Sanity check the parse**

Run a quick REPL check:

```bash
bun -e "import { parse } from 'smol-toml'; console.log(parse('[server]\nport = 3000\n'))"
```

Expected: `{ server: { port: 3000 } }` (or similar — value of `port` is an integer, not a string). If you get `Module not found`, the install failed silently — re-run `bun install`.

- [ ] **Step 4: Verify nothing else regressed**

Run: `bun run test`
Expected: same pass count as the baseline. No behavior should have changed because nothing imports `smol-toml` yet.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock
git commit -m "$(cat <<'EOF'
chore(deps): add smol-toml 1.3 for brust.toml loader

Preparation for runtime/config.ts which will read brust.toml at
startup. smol-toml is a 10 KB MIT-licensed TOML parser with no
transitive dependencies.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Write a failing test for the TOML-driven path

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Append the new `test()` block**

Open `tests/integration.test.ts`. After the last existing `test(...)` block, append:

```typescript
import { mkdtemp, writeFile, rm, copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('reads port and workers from brust.toml at cwd', async () => {
  // Create a throwaway project dir that contains:
  //   - a copy of the hello-world entry + component
  //   - a brust.toml that pins port 38125 and workers 2
  // Run with cwd = throwaway dir; assert the server listens on 38125.
  const dir = await mkdtemp(join(tmpdir(), 'brust-toml-'))
  try {
    const projectRoot = process.cwd()

    // Copy the example app under the temp dir, keeping the relative layout
    // (../../runtime/index.ts in the entry is resolved against the original
    // path, so we point BRUST_ENTRY at the absolute file rather than relocate
    // imports).
    const tomlBody = [
      '[server]',
      'port = 38125',
      '',
      '[workers]',
      'count = 2',
      '',
    ].join('\n')
    await writeFile(join(dir, 'brust.toml'), tomlBody)

    const proc = spawn({
      cmd: ['bun', 'run', join(projectRoot, 'example/hello-world/index.ts')],
      cwd: dir,
      env: {
        // Strip env overrides so TOML is the only source of truth.
        ...Object.fromEntries(Object.entries(process.env).filter(
          ([k]) => k !== 'BRUST_PORT' && k !== 'BRUST_WORKERS',
        )),
        RUST_LOG: 'brust=info',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    })

    const port = await readPortLine(proc.stdout)
    expect(port).toBe(38125)

    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    expect(await resp.text()).toContain('Hello from Brust')

    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
```

Note: the top-of-file imports already declare `spawn` from `'bun'` and `test, expect` from `'bun:test'`. The new `import` block sits next to those.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run test`
Expected: the new test fails. The most likely failure is `expect(port).toBe(38125)` reporting `received: 3000` — the example still reads only env vars, ignores `brust.toml`, and defaults to 3000. The other tests pass.

If you somehow see `expect(port).toBe(38125)` passing already, something is wrong — `loadConfig` doesn't exist yet. Re-check that `example/hello-world/index.ts` has not been edited; stop and inspect before continuing.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(config): failing test for brust.toml loader

Asserts that port and worker count are read from brust.toml at CWD
when no env override is present. RED until runtime/config.ts +
example/hello-world wiring lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Write the `runtime/config.ts` loader

**Files:**
- Create: `runtime/config.ts`

- [ ] **Step 1: Create the file with the full loader**

Create `runtime/config.ts` with:

```typescript
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'

export interface BrustConfig {
  /** TCP port to bind on. Default 3000. */
  port: number
  /** Bun Worker count for render dispatch. Default floor(availableParallelism * 1.8). */
  workers: number
}

export class BrustConfigError extends Error {
  constructor(message: string, public readonly file: string | null) {
    super(message)
    this.name = 'BrustConfigError'
  }
}

const DEFAULT_PORT = 3000
const defaultWorkers = (): number => Math.floor(os.availableParallelism() * 1.8)

const CONFIG_BASENAME = 'brust.toml'

/**
 * Resolve Brust configuration. Precedence (low → high): defaults < TOML < env.
 *
 * - Defaults: { port: 3000, workers: floor(availableParallelism * 1.8) }
 * - TOML: brust.toml at `cwd` (missing file is fine — only a present file with
 *   wrong shape is an error).
 * - Env: BRUST_PORT and BRUST_WORKERS override either source.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<BrustConfig> {
  let fromToml: Partial<BrustConfig> = {}
  const tomlPath = path.join(cwd, CONFIG_BASENAME)

  const file = Bun.file(tomlPath)
  if (await file.exists()) {
    let parsed: unknown
    try {
      parsed = parseToml(await file.text())
    } catch (e) {
      throw new BrustConfigError(
        `failed to parse ${tomlPath}: ${(e as Error).message}`,
        tomlPath,
      )
    }
    fromToml = extractFromToml(parsed, tomlPath)
  }

  const fromEnv = extractFromEnv()

  const port = pickPort(fromEnv.port, fromToml.port, DEFAULT_PORT)
  const workers = pickWorkers(fromEnv.workers, fromToml.workers, defaultWorkers())

  return { port, workers }
}

function extractFromToml(parsed: unknown, file: string): Partial<BrustConfig> {
  if (parsed === null || typeof parsed !== 'object') {
    throw new BrustConfigError(`${file}: top level must be a table`, file)
  }
  const root = parsed as Record<string, unknown>
  const out: Partial<BrustConfig> = {}

  if ('server' in root) {
    const server = root.server
    if (server === null || typeof server !== 'object') {
      throw new BrustConfigError(`${file}: [server] must be a table`, file)
    }
    const port = (server as Record<string, unknown>).port
    if (port !== undefined) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new BrustConfigError(
          `${file}: server.port must be an integer in 1..65535 (got ${JSON.stringify(port)})`,
          file,
        )
      }
      out.port = port
    }
  }

  if ('workers' in root) {
    const workers = root.workers
    if (workers === null || typeof workers !== 'object') {
      throw new BrustConfigError(`${file}: [workers] must be a table`, file)
    }
    const count = (workers as Record<string, unknown>).count
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        throw new BrustConfigError(
          `${file}: workers.count must be a positive integer (got ${JSON.stringify(count)})`,
          file,
        )
      }
      out.workers = count
    }
  }

  return out
}

function extractFromEnv(): Partial<BrustConfig> {
  const out: Partial<BrustConfig> = {}
  if (process.env.BRUST_PORT) {
    const n = parseInt(process.env.BRUST_PORT, 10)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new BrustConfigError(
        `BRUST_PORT must be an integer in 1..65535 (got ${JSON.stringify(process.env.BRUST_PORT)})`,
        null,
      )
    }
    out.port = n
  }
  if (process.env.BRUST_WORKERS) {
    const n = parseInt(process.env.BRUST_WORKERS, 10)
    if (!Number.isInteger(n) || n < 1) {
      throw new BrustConfigError(
        `BRUST_WORKERS must be a positive integer (got ${JSON.stringify(process.env.BRUST_WORKERS)})`,
        null,
      )
    }
    out.workers = n
  }
  return out
}

function pickPort(env: number | undefined, toml: number | undefined, fallback: number): number {
  return env ?? toml ?? fallback
}

function pickWorkers(env: number | undefined, toml: number | undefined, fallback: number): number {
  return env ?? toml ?? fallback
}
```

- [ ] **Step 2: Verify the file type-checks**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: clean output, no errors. If you see "Cannot find module 'smol-toml'", the install in Task 2 did not actually drop the package into `node_modules`. Re-run `bun install`.

If `tsc --noEmit` reports errors elsewhere in the repo unrelated to this file, treat them as pre-existing (the repo currently has no `tsc` step in CI). Confirm the only errors are in code you did not touch and proceed.

- [ ] **Step 3: Skip commit**

We commit `runtime/config.ts` together with the example-app wiring in Task 5 — the new module by itself does nothing observable.

---

### Task 5: Wire the loader into `example/hello-world/index.ts` and re-export from `runtime/index.ts`

**Files:**
- Modify: `runtime/index.ts`
- Modify: `example/hello-world/index.ts`

- [ ] **Step 1: Re-export `loadConfig` from the runtime facade**

Open `runtime/index.ts`. After the existing exports (at the bottom of the file, after the `brust` object), append:

```typescript

export { loadConfig, BrustConfigError } from './config.ts'
export type { BrustConfig } from './config.ts'
```

(Two blank lines before the new exports for readability.)

- [ ] **Step 2: Rewrite the example entry to use `loadConfig`**

Open `example/hello-world/index.ts`. Replace the block from line 11 down to line 17 (the inline env handling) with a call to `loadConfig`. The full new file:

```typescript
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import HelloWorld from './components/HelloWorld'

import {
  brust,
  isWorker,
  loadConfig,
} from '../../runtime/index.ts'

if (!isWorker) {
  const { port, workers } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)
  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
  })
} else {
  // 256KB shared buffer per worker — Rust captures the backing-store pointer at
  // register time and reads from it after every render call.
  const sab = new SharedArrayBuffer(256 * 1024)
  const view = new Uint8Array(sab)
  const encoder = new TextEncoder()

  let wid = ''
  const id = brust.registerRenderer(view, async (path: string) => {
    const html = renderToString(
      createElement(HelloWorld, { workerId: wid })
    )
    const { written } = encoder.encodeInto(html, view)
    return written ?? 0
  })
  wid = String(id)
}
```

Two things to notice:

1. The `import os from 'node:os'` import is **gone**. The default workers logic moved into `runtime/config.ts`.
2. Workers still call `brust.registerRenderer(view, async (path) => {...})` exactly as before — workers do not read `brust.toml`. The Worker spawn in `brust.serve(opts)` carries `BRUST_WORKER_ID` in its env, so each Worker re-runs this file under `isWorker === true` and skips the config load. **This is intentional** — the file system read happens once on the main thread.

- [ ] **Step 3: Run the integration test (TDD: now it should pass)**

Run: `bun run test`
Expected: all tests pass. Specifically:
- The original `serves rendered html via worker pool` test still passes — it sets `BRUST_PORT=38123` in env, env beats defaults, behavior unchanged.
- The wire-error-414 test (if landed) still passes — same env path, no config file.
- The new `reads port and workers from brust.toml at cwd` test passes — `brust.toml` in the temp dir is found, port 38125 is honored.

If only the TOML test fails, debug `loadConfig` first — `console.log(await loadConfig(...))` in the example temporarily. If the env tests fail, the precedence is inverted — env must beat TOML.

- [ ] **Step 4: Commit**

```bash
git add runtime/config.ts runtime/index.ts example/hello-world/index.ts
git commit -m "$(cat <<'EOF'
feat(config): brust.toml loader with env override

runtime/config.ts loads brust.toml at CWD (optional), validates the
[server].port and [workers].count fields, and merges with env and
defaults. Precedence: defaults < TOML < env. BRUST_PORT and
BRUST_WORKERS continue to work unchanged.

example/hello-world/index.ts switches to loadConfig() — the file is
gone of inline env parsing. The example app now also works with no
brust.toml at all (falls back to defaults + env).

Schema deliberately covers [server] and [workers] only; [cache] and
[build] land with their respective subsystems.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Ship an example TOML and gitignore the live one

**Files:**
- Create: `example/hello-world/brust.example.toml`
- Modify: `.gitignore`

- [ ] **Step 1: Create the example TOML**

Create `example/hello-world/brust.example.toml` with:

```toml
# Example brust.toml. Copy to brust.toml at your project root and edit.
# Env vars BRUST_PORT and BRUST_WORKERS override any value here.

[server]
# TCP port to bind on (1..65535). Default: 3000.
port = 3000

[workers]
# Bun Worker count for render dispatch.
# Default (omit this key): floor(os.availableParallelism() * 1.8).
# Pinning this is useful in containers where availableParallelism
# reports the host count, not the cgroup limit.
count = 18
```

- [ ] **Step 2: Update `.gitignore`**

Open `.gitignore`. Its current contents (3 lines per the `ls -la` output: `node_modules/`, `target/`, etc. — confirm with `cat .gitignore`). Append:

```
# Local app config. Check in brust.example.toml; ignore brust.toml.
brust.toml
```

The exact `# comment` line is mandatory — without it, future readers see `brust.toml` on its own and wonder if it was meant to be ignored.

- [ ] **Step 3: Verify `brust.toml` is correctly ignored if you make one**

Run:

```bash
touch brust.toml
git status --short
rm brust.toml
```

Expected: `git status --short` does **not** list `brust.toml`. If it does, the gitignore entry is in the wrong directory or has a typo.

- [ ] **Step 4: Commit**

```bash
git add example/hello-world/brust.example.toml .gitignore
git commit -m "$(cat <<'EOF'
docs(config): example brust.toml + gitignore the live one

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Update `architecture.md` Configuration section

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Locate the Configuration section**

Open `architecture.md`. Find the `### Configuration` heading (around line 770).

The current content lists today's env vars and ends with `Roadmap: brust.toml with [server], [workers], [cache], [build] sections.`

- [ ] **Step 2: Replace with the new section**

Replace the entire `### Configuration` block with:

```markdown
### Configuration

Layered, low → high precedence:

1. **Built-in defaults.** Port `3000`, workers `floor(os.availableParallelism() * 1.8)`.
2. **`brust.toml` at the project root.** Optional. Schema (extends as subsystems land):

   ```toml
   [server]
   port = 3000

   [workers]
   count = 18
   ```

   See `example/hello-world/brust.example.toml`.

3. **Environment variables.** Override TOML and defaults.
   - `BRUST_PORT` — TCP port.
   - `BRUST_WORKERS` — Bun Worker count.
   - `BRUST_WORKER_ID` — set per Worker by the framework; do not set manually.

The loader is in `runtime/config.ts` and exposes `loadConfig(cwd?)` plus the
`BrustConfig` type for app code that wants to read the merged config directly.

Roadmap sections: `[cache]` (Cache plan), `[build]` (build pipeline plan when
the CLI lands).
```

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): document layered config (defaults < toml < env)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run after implementation, before declaring done)

- [ ] `bun install` is idempotent; `git diff bun.lock` is clean.
- [ ] `bun run test` passes all tests, including the new TOML test.
- [ ] `bun run dev` from the repo root with no `brust.toml` listens on port 3000 (default).
- [ ] `bun run dev` from the repo root with a `brust.toml` containing `port = 4000` listens on port 4000.
- [ ] `BRUST_PORT=5000 bun run dev` listens on 5000 regardless of TOML or defaults.
- [ ] `runtime/index.ts` exports `loadConfig`, `BrustConfigError`, and the `BrustConfig` type.
- [ ] `runtime/config.ts` uses `Bun.file('brust.toml').exists()` rather than `fs.access` or static `import` — required for the "missing file is fine, malformed file is an error" semantics.
- [ ] `example/hello-world/index.ts` no longer imports `node:os` and no longer has inline `BRUST_PORT` / `BRUST_WORKERS` parsing.
- [ ] `.gitignore` ignores `brust.toml` but not `brust.example.toml`.
- [ ] `architecture.md` SConfiguration matches the new layered precedence.
- [ ] No Rust files were touched (`git diff HEAD~6 -- src/` is empty across the plan's commits).

## Risks and caveats

1. **Missing-file semantics.** `Bun.file(path).exists()` returns `false` for both nonexistent files and permission errors. If a user `chmod 000` their `brust.toml`, we silently fall back to defaults — same behavior as today's env-only path so no surprise, but worth knowing.
2. **`smol-toml` version drift.** Caret-pinned at `^1.3.1`. A 2.x release would auto-upgrade and could break parsing. If that happens, the new test in Task 3 will catch it — pin tighter then.
3. **CWD vs project root.** `loadConfig()` uses `process.cwd()`. Running the app from a subdirectory will not find a `brust.toml` at the repo root. That mirrors Node/Bun convention; documented in the architecture entry. A future CLI can add a project-root walk.
4. **Worker re-load.** Each Bun Worker re-runs `example/hello-world/index.ts` under `isWorker === true`. We skip `loadConfig` in the worker branch deliberately — the file is read once per process, not once per worker.

## Out of scope

- `[cache]` section. Lands with the Cache plan (Tier 2).
- `[build]` section. Lands with the build pipeline when the CLI plan arrives.
- CLI flag `--config=path/to/brust.toml`. The `brust` CLI itself doesn't exist yet; the override comes with that plan.
- Hot reload of config. Static read at boot. Restart to pick up changes.
- Validation of unknown keys (typo guard, e.g. `[serer]` → silent ignore today). Could be added later if it bites; "unknown keys are warnings" is the usual stance.
- Resolution of the `entry` field from TOML. Today the example app sets `entry: import.meta.url` directly; a future field like `[server].entry` would be useful when the CLI launches arbitrary entries.
