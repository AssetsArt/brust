# M2d — react island hydration in runtime-dom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` @a456712

**Goal:** `packages/runtime-dom` hydrates react-tier islands painted by the server: every `<brust-island data-id="…" x-props='…'>` element is hydrated once, when the browser is idle, by a `hydrate(host, props)` function that the island's own chunk registers through a global queue — spec S12.

**Architecture:** one new module `src/island.ts` (queue + scheduler) wired into `mount()`/`unmount()` the way `[x-data]` hosts are. The react chunk never imports the runtime: it pushes `[id, hydrate]` onto `globalThis.__brustIslands` and calls `globalThis.__brustIslandReady?.()`; the runtime drains that array on mount and on every later push. Hydration marks the host `data-hydrated="1"` so tests and the Chromium gate can wait on it.

**Tech Stack:** TypeScript, Bun 1.4.2 `bun test` with happy-dom (preload `test/setup.ts`), no new dependencies.

**Spec:** `docs/design/2026-10-09-m2-server-design.md` §6 (S12), §9 (S9: the server emits one `<script type="module">` per react chunk after the runtime script).

## Global Constraints

- No React in `runtime-dom`: the runtime only calls the `hydrate` function a chunk registered. `react`/`react-dom` never appear in `packages/runtime-dom/package.json`.
- One strategy only: idle (`requestIdleCallback`, fallback `setTimeout(fn, 1)`). No `load`/`visible`, no per-component override (M3).
- A host is hydrated at most once (`data-hydrated` guard), and never after it left the document.
- Load order independence: chunk before runtime, runtime before chunk, and chunk arriving after `mount()` must all hydrate. The queue protocol is the only coupling.
- `bun run ci`-style gates for this package: `cd packages/runtime-dom && bun test` and `bun run typecheck` green; `bun check` is not available on Bun 1.4.2 (ledger F8).
- Commit per task with the message given; one PR from `lane/m2d-island-hydration` to `v2`.

## Review Focus

1. **Chunk registers before the runtime exists** (script order inverted by a CDN hint): the queue array must be created by whoever comes first; Task 1 pins it with a test that pushes onto `globalThis.__brustIslands` before importing the runtime.
2. **Island removed from the DOM before idle fires** (SPA-less, but `x-if` can remove a native region containing an island): hydrate must not run on a disconnected host; Task 2 pins it.
3. **Malformed `x-props` JSON**: warn once with the island id and hydrate with `{}` rather than throwing (same rule as `readProps` in `mount.ts`); Task 2 pins it.
4. **`hydrate` throws**: `console.error('[brust] hydrate threw: <id>', e)` and leave the server HTML in place (the island stays static), no retry loop; Task 2 pins it.
5. **Two islands with the same id on one page**: both hydrate, each with its own props; Task 2 pins it.

---

### Task 1: Island queue and registry

**Files:**
- Create: `packages/runtime-dom/src/island.ts`
- Modify: `packages/runtime-dom/src/index.ts` (export `defineIsland`, `_resetIslands` for tests)
- Test: `packages/runtime-dom/test/island.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - Global protocol (used by the react chunk shim that the `m2c` lane generates):
    `(globalThis.__brustIslands ||= []).push([id: string, hydrate: (host: HTMLElement, props: Record<string, unknown>) => void]); globalThis.__brustIslandReady?.()`
  - `export type IslandHydrate = (host: HTMLElement, props: Record<string, unknown>) => void`
  - `export function defineIsland(id: string, hydrate: IslandHydrate): void` (in-process equivalent of the push, used by tests and by any chunk bundled together with the runtime)
  - `export function whenIsland(id: string, cb: (h: IslandHydrate) => void): void` (resolves now or when the chunk registers)
  - `export function _resetIslands(): void` (test helper)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime-dom/test/island.test.ts
import { expect, test } from 'bun:test'
import { defineIsland, whenIsland, _resetIslands } from '../src/island'

declare global { var __brustIslands: Array<[string, (host: HTMLElement, props: Record<string, unknown>) => void]> | undefined; var __brustIslandReady: (() => void) | undefined }

test('whenIsland resolves immediately for a defined island', () => {
  _resetIslands()
  const h = () => {}
  defineIsland('team_1', h)
  let got: unknown
  whenIsland('team_1', (f) => { got = f })
  expect(got).toBe(h)
})

test('whenIsland waits for a later defineIsland and fires once', () => {
  _resetIslands()
  let calls = 0
  whenIsland('late_2', () => { calls++ })
  expect(calls).toBe(0)
  defineIsland('late_2', () => {})
  defineIsland('late_2', () => {})   // re-registration does not re-fire old waiters
  expect(calls).toBe(1)
})

test('entries pushed onto globalThis.__brustIslands before the runtime drained are picked up', () => {
  _resetIslands()
  const h = () => {}
  ;(globalThis.__brustIslands ||= []).push(['early_3', h])
  let got: unknown
  whenIsland('early_3', (f) => { got = f })   // drains the queue on first use
  expect(got).toBe(h)
  expect(globalThis.__brustIslands!.length).toBe(0)
})

test('a push after the runtime installed __brustIslandReady is delivered through it', () => {
  _resetIslands()
  let got: unknown
  whenIsland('after_4', (f) => { got = f })
  const h = () => {}
  globalThis.__brustIslands!.push(['after_4', h])
  globalThis.__brustIslandReady?.()
  expect(got).toBe(h)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/runtime-dom && bun test test/island.test.ts`
Expected: FAIL — `Cannot find module '../src/island'`

- [ ] **Step 3: Implement `src/island.ts` (registry half)**

```ts
// packages/runtime-dom/src/island.ts
// React islands: the server paints <brust-island data-id x-props>HTML</brust-island>; the island's
// chunk registers a hydrate function through a global queue (no import of the runtime); the runtime
// hydrates each host once, when idle (spec S12). Load order between runtime and chunks is free.
import { warnOnce } from './warn'

export type IslandHydrate = (host: HTMLElement, props: Record<string, unknown>) => void
type QueueEntry = [string, IslandHydrate]
declare global { var __brustIslands: QueueEntry[] | undefined; var __brustIslandReady: (() => void) | undefined }

const registry = new Map<string, IslandHydrate>()
const waiters = new Map<string, Array<(h: IslandHydrate) => void>>()

export function defineIsland(id: string, hydrate: IslandHydrate): void {
  registry.set(id, hydrate)
  const w = waiters.get(id); waiters.delete(id)
  w?.forEach((cb) => cb(hydrate))
}

/** Move every queued [id, hydrate] from the global array into the registry. Idempotent. */
function drain(): void {
  const q = (globalThis.__brustIslands ||= [])
  while (q.length) { const [id, h] = q.shift()!; defineIsland(id, h) }
  globalThis.__brustIslandReady = drain
}

export function whenIsland(id: string, cb: (h: IslandHydrate) => void): void {
  drain()
  const h = registry.get(id)
  if (h) { cb(h); return }
  const list = waiters.get(id) ?? []; list.push(cb); waiters.set(id, list)
}

/** Test helper: forget registrations, waiters and the global queue. */
export function _resetIslands(): void {
  registry.clear(); waiters.clear()
  globalThis.__brustIslands = []
  globalThis.__brustIslandReady = undefined
}
// (Task 2 appends the scheduler below.)
export { warnOnce as _islandWarn }   // removed in Task 2 once the scheduler uses warnOnce directly
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/runtime-dom && bun test test/island.test.ts`
Expected: `4 pass, 0 fail`

- [ ] **Step 5: Export from the package index**

In `packages/runtime-dom/src/index.ts` append:
```ts
export { defineIsland } from './island'
export type { IslandHydrate } from './island'
```

- [ ] **Step 6: Typecheck and run the whole package suite**

Run: `cd packages/runtime-dom && bun run typecheck && bun test`
Expected: typecheck exits 0; `48 pass` (44 existing + 4 new), `0 fail`

- [ ] **Step 7: Commit**

```bash
git add packages/runtime-dom/src/island.ts packages/runtime-dom/src/index.ts packages/runtime-dom/test/island.test.ts
git commit -m "feat(runtime-dom): island registry with a global queue for react chunks"
```

---

### Task 2: Idle scheduler wired into mount/unmount

**Files:**
- Modify: `packages/runtime-dom/src/island.ts` (append the scheduler; drop the temporary `_islandWarn` export)
- Modify: `packages/runtime-dom/src/mount.ts:36-42` (`mountTree`), `:45-50` (`disposeTree`)
- Test: `packages/runtime-dom/test/island.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `whenIsland`, `_resetIslands`; `warnOnce(key, message)` from `src/warn.ts`; `mount`/`unmount` from `src/mount.ts`.
- Produces:
  - `export function scheduleIslands(root: ParentNode): void` — finds `brust-island[data-id]:not([data-hydrated])` under `root` (inclusive) and schedules each.
  - `export function cancelIslands(root: Node): void` — forgets pending hosts under a removed subtree.
  - Host contract: after hydration the host carries `data-hydrated="1"`; the Chromium gate in `m2e` waits for it.
  - Idle hook for tests: `export function _setIdle(fn: ((cb: () => void) => void) | null): void` — replaces the idle primitive (null = default).

- [ ] **Step 1: Write the failing tests** (append to `test/island.test.ts`)

```ts
import { defineIsland as def, _setIdle, _resetIslands as reset } from '../src/island'
import { mount, unmount } from '../src'

function html(s: string) { document.body.innerHTML = s; return document.body }
/** Run every callback the scheduler handed to the idle primitive. */
function makeIdle() { const q: Array<() => void> = []; _setIdle((cb) => q.push(cb)); return () => { while (q.length) q.shift()!() } }

test('hydrates each island host once when idle, with its x-props, and marks data-hydrated', () => {
  reset(); const flush = makeIdle()
  const seen: Array<[string, unknown]> = []
  def('team_a', (host, props) => { seen.push([host.id, props]) })
  html(`<brust-island id="x" data-id="team_a" x-props='{"n":1}'>server</brust-island><brust-island id="y" data-id="team_a" x-props='{"n":2}'>server</brust-island>`)
  mount()
  expect(seen).toEqual([])            // nothing before idle
  flush()
  expect(seen).toEqual([['x', { n: 1 }], ['y', { n: 2 }]])
  expect(document.querySelectorAll('brust-island[data-hydrated="1"]').length).toBe(2)
  mount(); flush()                    // a second mount pass does not re-hydrate
  expect(seen.length).toBe(2)
  unmount()
})

test('an island whose chunk arrives after mount hydrates when it registers', () => {
  reset(); const flush = makeIdle()
  const seen: string[] = []
  html(`<brust-island data-id="late_b" x-props='{}'>server</brust-island>`)
  mount(); flush()
  expect(seen).toEqual([])
  ;(globalThis.__brustIslands ||= []).push(['late_b', (h) => { seen.push(h.getAttribute('data-id')!) }])
  globalThis.__brustIslandReady?.()
  flush()
  expect(seen).toEqual(['late_b'])
  unmount()
})

test('a host removed before idle is not hydrated', () => {
  reset(); const flush = makeIdle()
  let calls = 0
  def('gone_c', () => { calls++ })
  html(`<div id="wrap"><brust-island data-id="gone_c" x-props='{}'>server</brust-island></div>`)
  mount()
  document.getElementById('wrap')!.remove()
  flush()
  expect(calls).toBe(0)
  unmount()
})

test('bad x-props JSON warns once and hydrates with {}', () => {
  reset(); const flush = makeIdle()
  const warnings: string[] = []; const w = console.warn; console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) }
  let got: unknown
  def('bad_d', (_h, props) => { got = props })
  html(`<brust-island data-id="bad_d" x-props='{oops'>server</brust-island>`)
  mount(); flush()
  console.warn = w
  expect(got).toEqual({})
  expect(warnings.some((m) => m.includes('bad x-props JSON') && m.includes('bad_d'))).toBe(true)
  unmount()
})

test('a hydrate that throws is reported on console.error and the server HTML stays', () => {
  reset(); const flush = makeIdle()
  const errors: string[] = []; const e = console.error; console.error = (...a: unknown[]) => { errors.push(String(a[0])) }
  def('boom_e', () => { throw new Error('nope') })
  html(`<brust-island data-id="boom_e" x-props='{}'>server html</brust-island>`)
  mount(); flush()
  console.error = e
  expect(errors.some((m) => m.includes('hydrate threw: boom_e'))).toBe(true)
  expect(document.querySelector('brust-island')!.textContent).toBe('server html')
  expect(document.querySelector('brust-island')!.hasAttribute('data-hydrated')).toBe(false)
  unmount()
})

test('islands inserted after mount (MutationObserver) are scheduled', async () => {
  reset(); const flush = makeIdle()
  const seen: string[] = []
  def('obs_f', (h) => { seen.push(h.id) })
  html(`<div id="root"></div>`)
  mount()
  document.getElementById('root')!.innerHTML = `<brust-island id="z" data-id="obs_f" x-props='{}'>s</brust-island>`
  await new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)))   // happy-dom delivers observer records in a microtask
  flush()
  expect(seen).toEqual(['z'])
  unmount()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/runtime-dom && bun test test/island.test.ts`
Expected: FAIL — `_setIdle is not a function` (and the rest fail after it)

- [ ] **Step 3: Append the scheduler to `src/island.ts`** (replace the two trailing lines from Task 1: the `// (Task 2 …)` comment and the `_islandWarn` export)

```ts
// ---- scheduler ----------------------------------------------------------------------------
type Idle = (cb: () => void) => void
const defaultIdle: Idle = (cb) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
  if (typeof ric === 'function') ric(cb); else setTimeout(cb, 1)
}
let idle: Idle = defaultIdle
export function _setIdle(fn: Idle | null): void { idle = fn ?? defaultIdle }

const pending = new Set<HTMLElement>()

function readIslandProps(host: HTMLElement, id: string): Record<string, unknown> {
  const raw = host.getAttribute('x-props')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} }
  catch { warnOnce(`ij:${id}:${raw.slice(0, 40)}`, `bad x-props JSON in island ${id}`); return {} }
}

function hydrateHost(host: HTMLElement, id: string, hydrate: IslandHydrate): void {
  pending.delete(host)
  if (!host.isConnected || host.hasAttribute('data-hydrated')) return
  try { hydrate(host, readIslandProps(host, id)); host.setAttribute('data-hydrated', '1') }
  catch (e) { console.error(`[brust] hydrate threw: ${id}`, e) }
}

function scheduleHost(host: HTMLElement): void {
  if (pending.has(host) || host.hasAttribute('data-hydrated')) return
  const id = host.getAttribute('data-id')!
  pending.add(host)
  whenIsland(id, (hydrate) => { if (pending.has(host)) idle(() => hydrateHost(host, id, hydrate)) })
}

/** Schedule every not-yet-hydrated island under `root` (inclusive). Called by mount() and the observer. */
export function scheduleIslands(root: ParentNode): void {
  if (root instanceof HTMLElement && root.tagName === 'BRUST-ISLAND' && root.hasAttribute('data-id')) scheduleHost(root)
  root.querySelectorAll<HTMLElement>('brust-island[data-id]').forEach(scheduleHost)
}

/** Forget pending hosts under a subtree that left the document. */
export function cancelIslands(root: Node): void {
  if (!(root instanceof Element)) return
  if (root instanceof HTMLElement && pending.has(root)) pending.delete(root)
  root.querySelectorAll<HTMLElement>('brust-island[data-id]').forEach((h) => pending.delete(h))
}
```

Also make `_resetIslands` clear the scheduler state: add `pending.clear(); idle = defaultIdle` inside it (it is defined above the scheduler; move the function below the scheduler or reference `pending`/`idle` through `let` hoisting — put `_resetIslands` at the END of the file to keep it simple).

- [ ] **Step 4: Wire mount.ts**

In `packages/runtime-dom/src/mount.ts`:
```ts
import { scheduleIslands, cancelIslands } from './island'
```
In `mountTree(root)`, after the `for (const h of hosts) mountHost(h)` loop, add:
```ts
  scheduleIslands(root)
```
In `disposeTree(root)`, as the first statement after the `instanceof Element` guard, add:
```ts
  cancelIslands(root)
```
(The observer already calls `mountTree` for added nodes and `disposeTree` for removed ones, so islands inserted or removed later are covered without touching `startObserver`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/runtime-dom && bun test test/island.test.ts`
Expected: `10 pass, 0 fail`

- [ ] **Step 6: Whole package gates**

Run: `cd packages/runtime-dom && bun run typecheck && bun test`
Expected: typecheck exits 0; `54 pass, 0 fail`

- [ ] **Step 7: Browser harness still green** (the island directive must not disturb native cases)

Run: `cd /path/to/worktree && bun run browser-test`
Expected: `11 pass` across 9 files, `0 fail` (same as `v2` @a456712)

- [ ] **Step 8: Commit**

```bash
git add packages/runtime-dom/src/island.ts packages/runtime-dom/src/mount.ts packages/runtime-dom/test/island.test.ts
git commit -m "feat(runtime-dom): hydrate react islands once when idle via the global queue"
```

---

### Task 3: README contract for chunk authors

**Files:**
- Modify: `packages/runtime-dom/README.md` (append a section)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: the written protocol the `m2c` lane's react chunk shim follows.

- [ ] **Step 1: Append to `packages/runtime-dom/README.md`**

```markdown
## React islands

The server paints a react-tier component as
`<brust-island data-id="<componentId>" x-props='<json>'>…server HTML…</brust-island>`.
The island's chunk registers its hydrate function without importing the runtime:

    ;(globalThis.__brustIslands ||= []).push(['<componentId>', (host, props) => hydrateRoot(host, <Comp {...props}/>)])
    globalThis.__brustIslandReady?.()

The runtime hydrates every host once, when the browser is idle (`requestIdleCallback`, else
`setTimeout(…, 1)`), and sets `data-hydrated="1"` on success. Load order between the runtime
script and island chunks does not matter. Bad `x-props` JSON hydrates with `{}` and warns once;
a hydrate that throws is reported on `console.error` and the server HTML stays. This is the only
strategy in M2 (spec S12).
```

- [ ] **Step 2: Commit**

```bash
git add packages/runtime-dom/README.md
git commit -m "docs(runtime-dom): island hydration protocol for chunk authors"
```

---

## Verification (READY evidence, paste in the task note)

```
cd packages/runtime-dom && bun run typecheck && bun test     # 54 pass
bun run browser-test                                          # 11 pass / 9 files
bun run battery && git status --short docs/                   # unchanged
```
PR `lane/m2d-island-hydration` → `v2`, CI green, lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2d-island-hydration` | 1–3 | standard | Implementer (Standard) | none | standard | Verification block pasted with counts; PR → `v2` CI green; lane HEAD sha |
