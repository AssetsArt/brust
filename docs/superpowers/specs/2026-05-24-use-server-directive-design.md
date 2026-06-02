# `"use server"` Directive + Boot-time Scanner — Design Spec

**Sub-project:** Tier-2 follow-up. Closes the loop on Server Functions MVP.
**Date:** 2026-05-24
**Status:** approved for implementation planning
**Parent design:** `architecture.md` S "Server functions"
**Related plans:** `2026-05-24-server-functions-design.md` (provides the manual registration API + action wire format this builds on)

---

## 1. Overview & Scope

### Goal

Replace the manual `brust.registerActions([...])` registry with a boot-time
scanner that walks the project, finds files marked `"use server"`, dynamically
imports them, and auto-registers every exported function as a server action.
Middleware is attached to individual actions via a `withMiddleware([...], fn)`
wrapper. No manifest file is emitted: scan runs at boot in both the main
process and every worker, producing identical in-memory `ActionDef[]` arrays.

```tsx
// example/hello-world/actions.ts
'use server'
import { withMiddleware, type BrustRequest, type Middleware } from 'brust'

const requireUser: Middleware = async (req, next) =>
  req.cookies['user'] ? next() : { status: 401, body: 'login required' }

export async function createNote(req: BrustRequest, text: string): Promise<{ id: string }> {
  return { id: 'n-' + Date.now() }
}

export const deleteNote = withMiddleware(
  [requireUser],
  async (req: BrustRequest, noteId: string): Promise<{ ok: true }> => {
    if (!noteId) throw new Error('noteId required')
    return { ok: true }
  },
)

// example/hello-world/index.ts (the only place scanActions is called)
const actions = await brust.scanActions()      // both main and worker
if (!isWorker) {
  await brust.serve({ port, workers, entry: import.meta.url, actions })
} else {
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid })
}
```

### Success criterion

> Running the example app after deleting every `defineActions`/`registerActions`
> call, an island mounted on `/note` still calls `await createNote('hi')`,
> still receives `{ id: 'n-...' }`, and `deleteNote` still 401s without a
> cookie. `cd runtime && bun run build && bun test tests/integration.test.ts`
> passes 30+ tests with the new scan path.

### Concrete acceptance

```bash
$ rm -f example/hello-world/index.ts.bak  # no manual defineActions left
$ grep -rn "registerActions\|defineActions" example/ runtime/index.ts
# only matches inside scanActions() implementation + internal `serve` glue

$ BRUST_PORT=38900 bun run example/hello-world/index.ts &
$ sleep 6
[brust] main: scanActions found 4 actions: createNote, whoAmI, deleteNote, pingAction
[brust] listening on 127.0.0.1:38900

$ curl -s -X POST -H 'content-type: application/json' \
  --data '["hi"]' http://127.0.0.1:38900/_brust/action/createNote
{"id":"n-1716527812345"}

$ curl -si -X POST -H 'content-type: application/json' \
  --data '["n-1"]' http://127.0.0.1:38900/_brust/action/deleteNote | head -1
HTTP/1.1 401 Unauthorized

$ curl -s -X POST -H 'content-type: application/json' -H 'cookie: user=alice' \
  --data '["n-1"]' http://127.0.0.1:38900/_brust/action/deleteNote
{"ok":true}

$ bun test tests/integration.test.ts
# 30+ pass — existing action tests still green, new scan-mode tests added

$ cargo test --lib
# 47 still pass — no Rust-side changes
```

### MVP scope decisions (locked during brainstorm 2026-05-24)

| Decision | Choice | Rationale |
|---|---|---|
| Directive scope | **File-level only** (`'use server'` as first statement) | Matches Next.js RSC convention. Mixed server/client files are an anti-pattern. Scanner stays O(file count), not O(AST nodes). |
| Scanner timing | **Boot-time only** (parallel to `buildIslands`) | Boot is the existing build seam. Avoids coupling to Bun.build plugin API. No watch/HMR loop yet. |
| Manual API | **Removed from user surface** | User asked for "zero manual registration". `defineActions` / `registerActions` keep existing names but become internal-only (re-exports dropped from `runtime/index.ts`). |
| Middleware binding | **`withMiddleware([...], fn)` wrapper** | Explicit, no naming-convention magic. Function identity preserved (return type is `F`), middleware metadata lives on a property the scanner reads. |
| Action id | **Bare export name** (the binding key from `Object.entries(mod)`) | Smallest mental model. Cross-file duplicates throw at scan time with both paths. NOTE: id comes from the export-binding name, NOT `fn.name` — `fn.name` is empty for `withMiddleware`-wrapped arrows because the JS NamedEvaluation rule only fires for bare function/arrow RHS, not for call expressions. The export key is always correct. |
| Scanner implementation | **Bun.glob + dynamic import** | Reuses Bun's filesystem APIs. No AST parser needed because dynamic import gives us function refs directly. |

### Out of scope (deferred)

1. **Function-level `"use server"`** — mixed server/client files. Add later if real apps need it.
2. **HMR / watch-mode re-scan** — dev-server feature, requires file watcher. Add with hot reload work.
3. **Forms & multipart** — own sub-project. This scanner sees void/Promise return signatures only.
4. **Manifest file emission** (`.brust/actions/manifest.ts`) — in-memory scan keeps moving parts minimal; emit only if devtools demand it later.
5. **Cross-package scanning** — only scans cwd subtree. Monorepos with action files in sibling packages need explicit `roots: [...]`.

---

## 2. User-facing API

### 2.1 The `"use server"` directive

A file is a server file iff the first non-comment, non-empty statement is the
string `'use server'` or `"use server"` (case-sensitive). Examples that count:

```ts
'use server'
export async function foo() {}
```

```ts
// header comment ok
/* block comment also ok */
"use server"
import { ... } from '...'
```

Examples that do NOT count (file is skipped, no exports registered):

```ts
import x from 'y'   // import before directive
'use server'
```

```ts
export const x = 'use server'   // not the first statement
```

This matches the [TC39 directive prologue](https://tc39.es/ecma262/#directive-prologue)
shape Next.js uses. Implementation detail in S3.

### 2.2 `withMiddleware` runtime helper

```ts
// runtime/actions.ts (already exists; add this export)
const BRUST_MW_KEY = '__brustMiddleware'

export function withMiddleware<F extends (...args: never[]) => unknown>(
  mws: readonly Middleware[],
  fn: F,
): F {
  if (!Array.isArray(mws) || mws.some((m) => typeof m !== 'function')) {
    throw new TypeError('withMiddleware expects an array of middleware functions')
  }
  // Reject double-wrap explicitly so users get a clear message instead of
  // the cryptic "Attempting to change value of a readonly property" that
  // a re-`defineProperty` would throw on a non-configurable slot.
  if ((fn as { [BRUST_MW_KEY]?: unknown })[BRUST_MW_KEY] !== undefined) {
    throw new Error(
      'withMiddleware called twice on the same function — compose middleware in a single call instead',
    )
  }
  Object.defineProperty(fn, BRUST_MW_KEY, {
    value: Object.freeze([...mws]),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return fn
}
```

Notes:

- Returns the input `fn` so the type signature is preserved verbatim. Client
  code that imports `typeof srv.deleteNote` sees the original arg/return types.
- Metadata stored as a non-enumerable, non-writable property → JSON.stringify
  skips it; nothing mutates it after creation.
- `Object.freeze` on the array elements: the array itself is frozen (no push /
  splice), but the middleware functions inside aren't deep-frozen. That's
  fine — middleware is invoke-only, never mutated.
- Double-wrap throws a clear error. Users who really want to layer middleware
  should call `withMiddleware([...a, ...b], fn)` once.

### 2.3 `brust.scanActions(options?)`

```ts
type ScanOptions = {
  /** Glob roots to scan from, relative to cwd. Default: ['./'].
   *  ⚠ Pass an explicit root (e.g. `import.meta.dirname`) whenever the project
   *  layout includes sibling subtrees you don't want scanned — typical when an
   *  example app sits inside a larger repo. */
  roots?: string[]
  /** Globs to ignore. Default covers build outputs AND common test patterns —
   *  real-world apps often have server-shaped functions in test fixtures
   *  (e.g. `tests/handlers.test.ts`). Override the array (not merge) if you
   *  need a different policy.
   *  Default: [
   *    'node_modules/**', '.brust/**', 'dist/**', 'build/**',
   *    'tests/**', '__tests__/**', '*.test.ts', '*.test.tsx',
   *    '*.spec.ts', '*.spec.tsx',
   *  ] */
  ignore?: string[]
}

export async function scanActions(opts?: ScanOptions): Promise<ActionDef[]>
```

- Returns the same `ActionDef[]` shape `defineActions` produced. Each
  `ActionDef` is `{ id, fn, middleware? }`.
- Idempotent across processes: same files + same exports → same array order
  (sorted by id for stability — important because Rust's HashSet doesn't care
  but `actions.length` logged at boot is the user-visible signal).
- Throws on:
  - Duplicate action ids (same export name in two files).
  - Anonymous exports (e.g. `export default async function() {}` — bare
    `export default` without identifier; `default` would collide with itself
    across files anyway).
  - Invalid action ids per `isValidActionId` (charset `[A-Za-z0-9_-]+`, 1-128).
  - A file with `'use server'` that exports zero functions (likely a bug).

### 2.4 `brust.serve({ ..., actions })`

`brust.serve` grows an `actions: ActionDef[]` field. When present, `serve`
calls the existing internal `registerActions` napi before binding the listener.
The user no longer calls `registerActions` directly.

```ts
export interface ServeOptions {
  port: number
  workers: number
  entry: string
  actions?: ActionDef[]   // NEW — required if any action will be dispatched
}
```

If `actions` is omitted or empty, the server boots without registering any
actions. `POST /_brust/action/<id>` 404s for everything — preserves old
behavior for users who don't need actions.

### 2.5 Removed user-facing exports

`runtime/index.ts` drops the following from its re-exports:
- `defineActions`
- `brust.registerActions`
- `ActionDef` / `ActionFn` types stay (used internally by `scanActions` return)

The names still exist internally — `scanActions` calls them under the hood.
Cleaner to keep them as the implementation rather than reimplement.

---

## 3. Scanner architecture

### 3.1 Directory walk

```ts
async function findCandidateFiles(opts: ScanOptions): Promise<string[]> {
  const roots = opts.roots ?? ['./']
  const ignore = opts.ignore ?? ['node_modules/**', '.brust/**', 'dist/**', 'build/**']
  const ignoreGlobs = ignore.map((p) => new Bun.Glob(p))
  const out: string[] = []
  for (const root of roots) {
    const glob = new Bun.Glob('**/*.{ts,tsx,js,jsx,mjs,cjs}')
    for await (const f of glob.scan({ cwd: root, dot: false, absolute: true })) {
      // Ignore patterns match the relative path from the scan root so
      // 'tests/**' works regardless of the cwd from which `bun run` was invoked.
      const rel = require('node:path').relative(root, f)
      if (ignoreGlobs.some((g) => g.match(rel))) continue
      out.push(f)
    }
  }
  return out
}
```

Default `roots: ['./']` scans from cwd. For projects where `bun run` is
invoked from a parent directory (e.g., the brust repo runs example apps via
`bun run example/hello-world/index.ts` from the repo root), pass an explicit
root so the scanner stays scoped to the app:

```ts
const actions = await brust.scanActions({ roots: [import.meta.dirname] })
```

This is what the example app migration uses (S7).

### 3.2 Directive check (read-only, no parse)

```ts
const DIRECTIVE_HEAD_BYTES = 512

async function hasUseServerDirective(filePath: string): Promise<boolean> {
  const f = Bun.file(filePath)
  const head = await f.slice(0, DIRECTIVE_HEAD_BYTES).text()
  // Skip leading comments + whitespace; the next thing must be the directive.
  const stripped = stripLeadingTrivia(head)
  return /^(?:'use server'|"use server")\s*;?\s*(?:\r?\n|$)/.test(stripped)
}

/** Remove leading whitespace, line comments (//), and block comments (/* * /).
 * Stops at the first non-trivial token. Does NOT handle string-aware logic —
 * that's overkill for the prologue position. */
function stripLeadingTrivia(src: string): string {
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl === -1) return ''
      i = nl + 1; continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return ''
      i = end + 2; continue
    }
    break
  }
  return src.slice(i)
}
```

The 512-byte head bound is well above any realistic comment block before a
directive. If a real file has a 500-byte license header, increase the bound;
not a default-case concern.

### 3.3 Module load + export collection

```ts
async function collectExports(filePath: string): Promise<ActionDef[]> {
  const mod = await import(filePath)
  const defs: ActionDef[] = []
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue
    // Skip class constructors — `typeof class{}` is 'function' in JS but
    // calling fn(req, ...args) without `new` throws TypeError at dispatch.
    // Better to skip at scan time so users get an explicit error if they
    // intended the class as an action.
    if (Function.prototype.toString.call(value).startsWith('class ')) {
      throw new Error(
        `${filePath}: export "${name}" is a class. Actions must be plain async functions, not class constructors.`,
      )
    }
    if (name === 'default') {
      throw new Error(`${filePath}: default exports are not action-eligible. Use named export.`)
    }
    if (!isValidActionId(name)) {
      throw new Error(`${filePath}: export "${name}" has invalid id (must match [A-Za-z0-9_-]+, 1-128 chars).`)
    }
    const mws: Middleware[] | undefined = (value as { __brustMiddleware?: Middleware[] }).__brustMiddleware
    defs.push({ id: name, fn: value as ActionFn, middleware: mws })
  }
  if (defs.length === 0) {
    throw new Error(`${filePath}: marked 'use server' but exports no functions.`)
  }
  return defs
}
```

### 3.4 Duplicate id detection

```ts
async function scanActions(opts: ScanOptions = {}): Promise<ActionDef[]> {
  const candidates = await findCandidateFiles(opts)
  const serverFiles = (
    await Promise.all(candidates.map(async (p) => (await hasUseServerDirective(p)) ? p : null))
  ).filter((p): p is string => p !== null)

  // Cross-file dedup. byId.get(name) -> first file that defined it.
  const byId = new Map<string, string>()
  const all: ActionDef[] = []
  for (const file of serverFiles) {
    const defs = await collectExports(file)
    for (const def of defs) {
      const prior = byId.get(def.id)
      if (prior) {
        throw new Error(
          `Duplicate action "${def.id}" — defined in both ${prior} and ${file}. Rename one.`,
        )
      }
      byId.set(def.id, file)
      all.push(def)
    }
  }
  all.sort((a, b) => a.id.localeCompare(b.id))   // stable order
  return all
}
```

### 3.5 Concurrency

The scanner runs file IO in parallel (`Promise.all` for directive checks),
serialises module imports (`for...of`) to avoid memory spikes when many files
each have heavy side-effect imports. With ~10 server files this is sub-100 ms;
sub-projects with hundreds of files can flip to parallel imports later.

---

## 4. Worker coordination

Today, `defineActions` is called at module top-level in both main and worker
contexts of `example/hello-world/index.ts`. The shared module-level binding
means both ends see the same `actions` array.

After this change, `await brust.scanActions()` replaces `defineActions`. It's
also called at module top-level, so:

- **Main process** scans → registers ids with Rust via internal call →
  starts serve loop.
- **Each worker process** scans → uses the array to build the renderer's
  `actions` map. Worker does NOT call `registerActions` against Rust — Rust
  state is process-global to main, and workers don't share that registry.
  Each worker just needs the in-memory map to dispatch by `action_id` when
  the envelope arrives.

**Cost accounting:** with `workers: N` you pay N+1 directory walks + N+1
sets of dynamic-imports at boot, one per JS context. For ~10 server files
and 4 workers, that's ~5 ms × 5 = ~25 ms total scan time at boot. Acceptable
for an MVP. Future optimisation: emit `.brust/actions/manifest.ts` once
from main, have workers `import` the manifest instead of re-scanning. Out
of scope for this MVP — see S11.

Because workers spawn from the same `entry` file as main (`new Worker(opts.entry, ...)`
in `runtime/index.ts`), they import the same `index.ts`, hit the same
top-level `await brust.scanActions()`, and find the same files in the same
order (sort is deterministic). The two ends end up with structurally-equal
arrays — same length, same ids, same middleware metadata.

**Function identity is per-process.** Each worker's JS context produces a
fresh function instance for `createNote`, distinct from main's. Nothing
relies on reference equality between contexts: action dispatch uses the
id-keyed map, and middleware arrays are invoked through `composeChain`,
never compared. Safe.

**Verification at boot:** Rust's action registry sees ids from main. Worker
sees actions from its own scan. If they diverge (e.g., a file is added
between main scan and worker scan — unlikely but possible during fast
dev-loop edits), dispatch from Rust to worker with an unknown id falls into
the existing `[brust] unknown action_id=...` handler at `runtime/routes.ts`
(returns JSON 404). So divergence degrades gracefully, doesn't crash.

---

## 5. Error handling

### 5.1 At scan time (process-fatal)

- File has `'use server'` but `await import(file)` throws (TS error, runtime
  error in module top-level) → re-throw with `[brust] scanActions failed to
  import "<file>": <original>`. Likely user-fixable.
- Duplicate id across files → throw with both paths (S3.4).
- Invalid id charset → throw with file path + offending name (S3.3).
- `'use server'` file with zero function exports → throw (likely a bug).
- Bun.glob throws → bubble up unchanged.

All of these terminate the process at boot before the listener binds. That's
the right call: failing early on misconfiguration is far better than
silently registering the wrong actions.

### 5.2 At runtime (existing behavior unchanged)

- POST to unknown id → 404 (Rust + JS double-check, unchanged).
- `withMiddleware` chain runs as before; uncaught middleware throws emit
  `{"error":{"message":"internal error"}}` JSON 500.
- Action body throws → `{"error":{"message":<msg>,"name":<name>}}` JSON 500.

---

## 6. Type safety

The client-side type erasure pattern is unchanged:

```ts
// island component
import { action } from 'brust/client'
import type * as srv from '../actions'

const createNote = action<typeof srv.createNote>('createNote')
const deleteNote = action<typeof srv.deleteNote>('deleteNote')
```

- `import type` is erased by Bun's bundler. The actual `../actions` file
  (with `'use server'` at the top and live function refs) never reaches the
  browser bundle.
- `typeof srv.createNote` returns the original async function signature
  because `withMiddleware<F>(mws, fn): F` returns `F`. Wrapping does not erase
  the function type.

The new directive doesn't change this contract — it just changes how the
SERVER side discovers the functions. Type inference on the client is
identical.

---

## 7. Migration plan for the example app

`example/hello-world/index.ts` diff:

```diff
-import { brust, isWorker, loadConfig, makeRenderer, buildIslands, defineActions, type Middleware } from '../../runtime/index.ts'
+import { brust, isWorker, loadConfig, makeRenderer, buildIslands } from '../../runtime/index.ts'
 import { routes } from './routes'
-import { createNote, whoAmI, deleteNote, pingAction } from './actions'

-const requireUser: Middleware = async (req, next) => {
-  if (!req.cookies['user']) {
-    return { status: 401, body: 'login required' }
-  }
-  return next()
-}
-
-const actions = defineActions([
-  { id: 'createNote', fn: createNote },
-  { id: 'whoAmI',     fn: whoAmI },
-  { id: 'deleteNote', fn: deleteNote, middleware: [requireUser] },
-  { id: 'pingAction', fn: pingAction },
-])
+// Scope the scan to the example dir — `bun test` runs from the repo root so
+// default cwd would otherwise pick up other example apps + test fixtures.
+const actions = await brust.scanActions({ roots: [import.meta.dirname] })

 if (!isWorker) {
   const { port, workers, cacheMaxEntries } = await loadConfig()
   // ...
-  brust.registerRoutes(routes)
-  brust.registerActions(actions)
-  console.log(`[brust] main: registered ${actions.length} action(s)`)
-
-  await brust.serve({ port, workers, entry: import.meta.url })
+  brust.registerRoutes(routes)
+  await brust.serve({ port, workers, entry: import.meta.url, actions })
 } else {
   // unchanged
 }
```

`example/hello-world/actions.ts` diff:

```diff
+'use server'
+import { withMiddleware } from '../../runtime/index.ts'
 import type { BrustRequest, Middleware } from '../../runtime/routes.ts'

+const requireUser: Middleware = async (req, next) =>
+  req.cookies['user'] ? next() : { status: 401, body: 'login required' }
+
 export async function createNote(req: BrustRequest, text: string): Promise<{ id: string }> { ... }
 export async function whoAmI(req: BrustRequest): Promise<{ user: string | null }> { ... }
-export async function deleteNote(req: BrustRequest, noteId: string): Promise<{ ok: true }> { ... }
+export const deleteNote = withMiddleware(
+  [requireUser],
+  async (req: BrustRequest, noteId: string): Promise<{ ok: true }> => { ... },
+)
 export async function pingAction(_req: BrustRequest): Promise<void> {}
```

The middleware definition moves from `index.ts` to `actions.ts` — which is
where it belongs anyway, since the middleware is action-specific.

---

## 8. Testing

### 8.1 Unit tests (new file `tests/scan-actions.test.ts`)

Spawn `bun test` in a temp directory with a controlled file layout:

- One file with `'use server'` exporting 2 fns → 2 ActionDefs returned, sorted.
- File without directive → skipped.
- Directive after `import` statement → skipped (negative case).
- Two files exporting same name → throws with both paths.
- File with `'use server'` but no function exports → throws.
- Function wrapped in `withMiddleware([m1, m2], fn)` → ActionDef.middleware contains [m1, m2] in order.
- Invalid id charset (file with `export const 'bad.id'` — actually unreachable
  in TS syntax, so test with a programmatically-named function) → throws.
- `roots: ['./subdir']` → only files under subdir scanned.
- `ignore: ['skip-me/**']` → matched files excluded.

### 8.2 Integration tests (extend `tests/integration.test.ts`)

- After deleting all `defineActions`/`registerActions` calls from the example
  app and adding `'use server'` to actions.ts:
  - All 11 existing action tests in `tests/integration.test.ts` still pass
    (happy path, malformed JSON 400, non-array 400, unknown id 404, GET 405,
    bad charset 404, missing CL 411, undefined return 200, CL > 256 KB 413,
    middleware short-circuit 401, middleware pass-through 200) PLUS the
    `/note` island wiring test that exercises action invocation end-to-end.
  - Boot log line `[brust] scanActions found N actions` appears in stdout.

### 8.3 Negative integration test (boot failure)

- Add a second example file `example/scan-broken/actions-bad.ts` with
  `'use server'` and a duplicate `createNote` export. Run the server and
  assert it exits non-zero with the dup error in stderr. Cleaner: a unit
  test on `scanActions` directly with a fixture directory.

---

## 9. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Scanner finds test fixtures, builds an action from a test fn | Med | Default `ignore` excludes `node_modules/**`, `.brust/**`, `dist/**`, `build/**`. Example apps + test harnesses pass explicit `roots: [import.meta.dirname]` to scope the scan to their own dir. Project-rooted apps generally won't have test files at the project root, so the default is safe. |
| Class export picked up as an action and 500s at dispatch | Low | Scanner explicitly rejects class constructors at scan time (S3.3) with a clear error message — no chance of registering a class as an action. |
| Boot time grows with N server files (each `await import`) | Low | Serial import for safety; flip to parallel if benchmarks ever show >50 ms. Document the budget. |
| A `'use server'` file imports a heavy module (e.g. database client) that runs at top-level | Med | Acknowledged as user responsibility — same as today's top-level imports. Document in spec. |
| Two workers race to register different action sets after a dev-loop file rename | Low | Unknown id at dispatch → JSON 404 (existing handler). Restart workers fixes it. |
| Double-wrap with `withMiddleware` produces a confusing error | Low | The helper detects prior `__brustMiddleware` and throws a clear "called twice on the same function — compose in a single call instead" (S2.2). |

---

## 10. Implementation order

Suggested task split for the plan phase (writing-plans will refine):

1. **`runtime/actions.ts` — add `withMiddleware` helper + tests** (~30 min).
2. **`runtime/scan-actions.ts` — new file, `scanActions` + helpers + unit tests** (~3 h).
3. **`runtime/index.ts` — expose `brust.scanActions`, drop public `defineActions` / `brust.registerActions` re-exports** (~30 min).
4. **`runtime/index.ts` — `brust.serve` accepts `actions` and calls internal `registerActions`** (~30 min).
5. **Migrate `example/hello-world/`** — actions.ts gets `'use server'` + `withMiddleware`; index.ts swaps to `scanActions` (~30 min).
6. **Integration tests** — port the existing 8 action tests to the scan path; add boot-failure test (~1 h).
7. **`architecture.md` update** — promote `"use server"` directive from "Designed not built" to "Built" (~15 min).

Total estimate: ~6 hours of focused work (~1 day with reviews via subagent-driven-development).

---

## 11. Open follow-ups (post-MVP)

These are intentionally NOT in scope for this plan:

- **Function-level `'use server'`** for mixed files.
- **Watch-mode rescan** (hot reload during dev).
- **Manifest emission** to `.brust/actions/manifest.ts` for devtools.
- **Cross-package monorepo scan** via `roots: ['../shared-actions/']`.
- **Action-discovery for the agentic surface** — once this exists, the agentic
  manifest builder can reuse `scanActions` + augment with schema extraction.
