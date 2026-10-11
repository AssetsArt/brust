# m3f-store-core: one reactive core on globalThis, the 0.1.x store API in @brust/runtime-dom, the React bridge and the @brust/core/store subpaths

**RULED by lead Detoro 2026-10-11 (before dispatch): R1 ACCEPTED (runtime bundle cap 14 KB → 17 KB; README + test/build.test.ts only). R2 ACCEPTED — spec C6 amended: `@brust/core/store/react` is bundled into the islands build, never in the React-free runtime; the server lane's `bundle.ts` task encodes it (no challenge needed at lane start). R3 ACCEPTED (0.1.x error strings verbatim; spec §4 amended). R4 ACCEPTED (resolver-first; spec §4 amended). Notes for the server lane carried into its plan: add `@brust/runtime-dom(/*)` to JOBS_EXTERNALS; C4 golden bytes from serialize test 8.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m3f (worktree ~/code/brust-m3f) · lane: m3f-store-core · tier: standard · review: complex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land spec §2.1 and the store-core rows of §6 on `lane/m3f-store-core`.
- `packages/runtime-dom` gets the 0.1.x `brustjs/store` API on its existing core: `signal.ts` keeps its tracking state on `globalThis[Symbol.for('brust.reactive.ctx')]` and brands signals and computeds. New modules: `defineStore`, serialization, the browser registry with the server-resolver hook, and `useStore`.
- `@brust/core` exposes this API as `./store` and `./store/react`. Every existing runtime-dom test stays green with no assertion change; the one exception is the bundle-size cap (ruling R1).

**Reading order:**
1. Spec `docs/design/2026-10-11-m3f-unified-store-design.md`: §1 D1, D2, D3, D6, D8, D9; §2.1; §3 C6, C7, C8; §4; §6.
2. `packages/runtime-dom/src/signal.ts` (all 94 lines), `value.ts:1,24,34,42`, `directives/model.ts:3,10`, `index.ts`, `scripts/build.ts:7`, `test/build.test.ts:5-13`, `test/setup.ts`.
3. `packages/brust/src/build/bundle.ts:103,128,194-212,260-277,281` (read only, to see how the runtime and the islands resolve the code you write).
4. 0.1.x reference, read-only, at `~/code/brust` (branch main):
   - `runtime/store/{signal,define-store,serialize,react,server-context,client-hydrate,index}.ts`;
   - their `*.test.ts`;
   - `runtime/render/inject-store.test.ts`.

**Evidence (prototype, measured before this plan was written; scratch copy of runtime-dom @3342353):**
- The `globalThis` ctx and the brands alone take the minified runtime-dom bundle from 13,900 B to 14,401 B. That is over the 14,336 B cap at `test/build.test.ts:13`. With the full store re-exported, the bundle is 16,411 B. See R1.
- Microbench: 1M `set` → computed → effect, plus 2,000 effect create/dispose, 5 runs × 3 rounds. Old core 258.0/258.3/259.4 ms; new core 260.3/260.1/261.7 ms, about +0.8%.
- The v2 core does NOT make cleanups untracked. In a cleanup that runs inside a nested flush, a read subscribes the OUTER effect: probe `outerRuns` was 2, the expected value is 1. Task 1 fixes this.
- v2 has no re-entrancy guard (D2: "behaviour otherwise unchanged"). So the 0.1.x test "effect that reads and conditionally writes the same signal does not stack-overflow" settles by bounded recursion: runs = 4 and a = 3, then 8 and 3 after `a.set(0)`. 0.1.x got 1 and 1.
- Bun loads a byte-copy of `signal.ts` from a temp dir as a distinct module instance. That is how the two-copies test proves cross-copy tracking.
- Trap: one prototype write tool turned the escape text `\u2028` into the raw U+2028 character. A raw U+2028 inside a regex literal is a line terminator, so the file failed with `Syntax Error`. Keep the six-character escapes. After writing, check with `grep -nP '\x{2028}|\x{2029}' packages/runtime-dom/src/store/serialize.ts`, which must print nothing.

## Global constraints

**Rulings requested from the lead before dispatch.** Each has a default that the implementer follows unless the lead answers differently.
- **R1 — runtime-dom bundle cap 14 KB → 17 KB.** Spec §2.1 puts the store into `src/index.ts`, and the runtime entry `export * from '@brust/runtime-dom'` (`bundle.ts:196`) ships it. Measured: 16,411 B. Change `test/build.test.ts:5,13` (name "under 17 KB", `17 * 1024`) and `README.md:5` ("< 17 KB"). Nothing else in that test changes. The react-free assertions (`:11-12`, `scripts/build.ts:7`) stay. Default: ACCEPT. If refused, STOP: the only alternative is to move the store out of `index.ts`, which contradicts §2.1 and C6.
- **R2 — C6 / D3 wording for `@brust/core/store/react` (the challenge the lane files at start; the fix is in the SERVER lane's `bundle.ts`).**
  - The problem: C6 resolves `@brust/core/store*` to the runtime URL in island builds. The runtime is react-free by contract (`scripts/build.ts:7`, `test/build.test.ts:11-12`), so it cannot export `useStore`.
  - Proposed C6: `@brust/runtime-dom`, `@brust/runtime-dom/store`, `@brust/core/store` → runtime URL. `@brust/core/store/react` and `@brust/runtime-dom/store/react` are bundled into the island build with React.
  - Why that is safe: this lane writes `store/react.ts` with no value import from the core (only `import type` plus `react`), so bundling it adds no second core.
  - Default: ACCEPT. File it with `task challenge` on the m3f-store-server task, quoting this paragraph.
- **R3 — error text.**
  - The conflict: spec §4 quotes `"<name>: used outside a request scope"` as the 0.1.x text. 0.1.x actually throws `store '<name>' accessed outside a request scope` (`server-context.ts:25`) and `store '<name>' accessed on the server without a request scope` (`define-store.ts:121`).
  - D1 says the API is ported verbatim. Default: keep the 0.1.x strings verbatim. This lane throws the second one; the server lane's resolver throws the first.
- **R4 — resolution order (an implementation choice; listed so that a reviewer does not "fix" it back).**
  - Rule: a resolver, if installed, takes EVERY store access. Without one, the browser registry is used when `typeof document !== 'undefined'`; otherwise the access throws.
  - 0.1.x branched on `typeof window` first (`define-store.ts:109`).
  - Why: the worker fails safe. A polyfilled `window` or `document` can never route per-request state into the page-global registry. This also drops the 0.1.x `window = undefined` test hack (`define-store.test.ts:10-14`).
  - Default: ACCEPT.

**Lane:**
```
cd ~/code/brust-m3f && git pull --ff-only && git worktree add ../brust-lane-m3f-store-core -b lane/m3f-store-core m3f
cd ../brust-lane-m3f-store-core && bun install --frozen-lockfile
```
Do NOT use `conclave lane start`, which branches from `main`. All line numbers are at m3f @3342353 (= v2 @3342353). If the code moved, re-anchor on the quoted text and say so in the task note.

**TDD.** Every task writes its failing tests first, runs them, and pastes the red line into the task note before any implementation.

**Typecheck.** In each touched package, `bun run typecheck` (= `bun check`, TS7) prints `No type errors`. There is no root biome config (`ls biome.json*` → none), so there is no `bun run ci` gate. CI runs exactly `cd packages/runtime-dom && bun run typecheck && bun test && bun scripts/build.ts` (`.github/workflows/ci.yml:51-53`).

**Existing runtime-dom tests are untouched:**
- Files: `test/{build,for,if-model,island,mount,ref-props-bind,registry,signal,text-show-bind-on}.test.ts`.
- Baseline: `cd packages/runtime-dom && bun test` → `54 pass`, `0 fail`, `133 expect() calls`, `Ran 54 tests across 9 files`.
- After every task those 54 still pass, and `git diff m3f -- packages/runtime-dom/test/*.test.ts` shows only `build.test.ts:5,13` (R1). New tests go under `packages/runtime-dom/test/store/`.

**Commits.** Never `git add -A`; stage by name. Before each commit, `git status --short` lists exactly the task's files. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. NO PR: post READY on the Conclave task, and the lead merges into `m3f`.

**Do not re-decide:**
- D1 surface: exactly `signal computed effect batch untracked isSignal isComputed defineStore` and the types `Signal Computed Dispose StoreHandle Snapshot`.
- C7 keys, verbatim: `Symbol.for('brust.reactive.ctx')`, `Symbol.for('brust.stores')`, `Symbol.for('brust.signal')`, `Symbol.for('brust.computed')`.
- C8 reserved handle members: `name subscribe snapshot serialize hydrate then`.
- Sync flush and the `Object.is` guard (D2).
- Lazy seeding on first access (D6).
- No selectors (D8).
- No SPA snapshot application wired anywhere (D9; `applyStoreSnapshot` exists and has no callers).

## Boundary (exact)

- `packages/runtime-dom/src/signal.ts` (whole file).
- `packages/runtime-dom/src/value.ts`, ONLY the import at :1 and the three `isSignal(cur)` calls at :24,:34,:42, which become `isReactive(cur)`.
- `packages/runtime-dom/src/index.ts`.
- NEW `packages/runtime-dom/src/store/{serialize,registry,define-store,react,index,internal}.ts`.
- `packages/runtime-dom/package.json` (`exports`, `peerDependencies`, `peerDependenciesMeta`, `devDependencies`).
- `packages/runtime-dom/README.md`: the size at :5 and a new "Store" section.
- `packages/runtime-dom/test/build.test.ts:5,13` (R1 only).
- NEW `packages/runtime-dom/test/store/{signal,two-copies,serialize,registry,define-store,react,exports}.test.ts`.
- `packages/brust/package.json` (`exports` only).
- NEW `packages/brust/src/store/index.ts`, `packages/brust/src/store/react.ts`.
- NEW `packages/brust/test/store-exports.test.ts`.
- `bun.lock`: only the lines `bun install` writes for the runtime-dom devDependencies and peers.

NOT touched:
- `packages/brust/src/store/server-context.ts` (SERVER lane; it calls the hook defined in Task 3);
- `worker.ts`, `bundle.ts`, `crates/**`, `examples/**`, `tests/**`, `docs/**`;
- `directives/model.ts`: its `isSignal(sig) || typeof … .set` check (:10) keeps its behaviour under the signal-only `isSignal`, so it needs no edit.

## Tasks

### Task 1: The core on globalThis, brands, untracked cleanups

**Files:** `src/signal.ts`, `src/value.ts`, `test/build.test.ts` (R1), `README.md:5`. NEW `test/store/signal.test.ts`, `test/store/two-copies.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `test/store/signal.test.ts` ports 0.1.x `runtime/store/signal.test.ts`. The names are the contract; the 0.1.x assertions carry over except where noted. It imports `../../src/signal`.
    1. `signal read returns initial; .set(v) updates; .set(fn) updates from prev`
    2. `Object.is guard: .set to equal value does NOT notify`
    3. `computed memoizes for repeated reads with no dep change; recomputes after dep .set`
    4. `effect runs once immediately, re-runs on tracked dep change, stops after dispose`
    5. `batch: two .set inside one batch → effect re-runs once`
    6. `effect that reads and conditionally writes the same signal does not stack-overflow`. **v2 assertions:** after `effect(() => { runs++; if (a() < 3) a.set(a() + 1) })`, `runs === 4` and `a() === 3`; after `a.set(0)`, `runs === 8` and `a() === 3`. The comment says that v2 has no re-entrancy guard (D2), so the nested flush converges.
    7. `effect cleanup: returned fn runs before each re-run and once on dispose`
    8. `effect cleanup runs UNTRACKED — reading a signal inside cleanup adds no dependency`
    9. `effect cleanup inside a nested effect run is untracked` (NEW; red on today's core):
       ```ts
       const trig = signal(0), other = signal(0); let outerRuns = 0
       effect(() => { trig(); return () => { other() } })
       effect(() => { outerRuns++; if (outerRuns === 1) trig.set(1) })
       other.set(5); expect(outerRuns).toBe(1)
       ```
    10. `disposing an effect whose cleanup writes a depended-on signal does NOT re-run the body`
    11. `dispose() called twice runs cleanup exactly once and does not throw`
    12. `effect with no returned cleanup (void) still works and disposes cleanly`
    13. `brands: isSignal / isComputed`: `isSignal(computed(..)) === false` and `isComputed(signal(..)) === false`. These are 0.1.x semantics, and they are red today, because `isSignal` is the `'peek' in x` check at `signal.ts:92-94`.
    14. `brands use the global Symbol registry (Symbol.for) so they are cross-chunk-stable`
  - `test/store/two-copies.test.ts`: `brands and tracking hold across two module instances` (red today: tracking is module-local).
    ```ts
    import { copyFileSync, mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
    import * as A from '../../src/signal'
    async function secondCopy(): Promise<typeof A> {
      const dir = mkdtempSync(join(tmpdir(), 'brust-signal-copy-')); const file = join(dir, 'signal.ts')
      copyFileSync(join(import.meta.dir, '../../src/signal.ts'), file)
      return (await import(file)) as typeof A   // a distinct module instance (verified on Bun canary)
    }
    // B = await secondCopy(); expect(B.signal).not.toBe(A.signal)
    // brands: A.isSignal(B.signal(1)), B.isSignal(A.signal(1)), A.isComputed(B.computed(() => 1)) all true; B.isSignal(A.computed(() => 1)) false
    // tracking: s = B.signal(0); A.effect(() => { s(); runs++ }); s.set(1) → runs 2
    //           c = A.computed(() => s() * 2); B.effect(() => seen.push(c())); A.batch(() => { s.set(2); s.set(3) }) → seen [2, 6], runs 3
    // ctx: (globalThis as any)[Symbol.for('brust.reactive.ctx')] is defined and has keys currentSub, batchDepth, pending
    ```
    Use a temp-file copy, not `import('../../src/signal.ts?copy=2')`: a query specifier also works in Bun, but `bun check` cannot type it.
  - Run `cd packages/runtime-dom && bun test test/store` and paste the red names. Expected red: 9 (nested cleanup), 13 (brands), 14 (Symbol.for brands) and two-copies. Test 6 is already green on today's core (probe: 4/3, then 8/3), because it pins v2 behaviour rather than a change.
- [ ] **Step 2: Implementation.** `src/signal.ts` keeps its structure; only the marked lines change.
  ```ts
  type Subscriber = { mark(): void; deps: Set<Node> }
  type Node = { subs: Set<Subscriber> }
  type Runnable = { disposed: boolean; run(): void }
  interface ReactiveCtx { currentSub: Subscriber | null; batchDepth: number; pending: Set<Runnable> }

  const CTX = Symbol.for('brust.reactive.ctx')          // C7
  const SIGNAL = Symbol.for('brust.signal')             // C7
  const COMPUTED = Symbol.for('brust.computed')         // C7
  // ONE object per realm. Every copy of this module binds `ctx` once at load; hot paths do one
  // property load on a module-constant object (measured +0.8%, Evidence). The shape is fixed:
  // a copy never adds fields, so copies of any v2 version agree.
  const ctx: ReactiveCtx = ((globalThis as { [CTX]?: ReactiveCtx })[CTX] ??= { currentSub: null, batchDepth: 0, pending: new Set() })

  function track(node: Node) { const s = ctx.currentSub; if (s) { node.subs.add(s); s.deps.add(node) } }
  function flush() {
    if (ctx.batchDepth > 0) return
    const pending = ctx.pending
    while (pending.size) { const batch = Array.from(pending); pending.clear(); for (const e of batch) if (!e.disposed) e.run() }
  }
  export interface Signal<T> { (): T; set(next: T | ((prev: T) => T)): void; readonly peek: () => T; readonly [SIGNAL]: true }
  export interface Computed<T> { (): T; readonly peek: () => T; readonly [COMPUTED]: true }
  ```
  - `signal()` is unchanged except `;(read as { [SIGNAL]: true })[SIGNAL] = true` before `return read`. Use a plain assignment, NOT `Object.defineProperty`: it is cheaper per creation, and the brand tests only check `=== true`.
  - `computed()`: `currentSub` becomes `ctx.currentSub` in `recompute`; add `;(read as { [COMPUTED]: true })[COMPUTED] = true`.
  - `EffectImpl`: `mark() { ctx.pending.add(this) }`; `dispose` uses `ctx.pending.delete(this)`. Both cleanup sites (`run` at :63, `dispose` at :72) call:
    ```ts
    function runCleanup(c: () => void) { const prev = ctx.currentSub; ctx.currentSub = null; try { c() } finally { ctx.currentSub = prev } }
    ```
  - `batch`/`untracked`: `batchDepth`/`currentSub` become `ctx.batchDepth`/`ctx.currentSub`.
  - Replace `isSignal` (:92-94) with:
    ```ts
    export function isSignal(x: unknown): x is Signal<unknown> { return typeof x === 'function' && (x as { [SIGNAL]?: true })[SIGNAL] === true }
    export function isComputed(x: unknown): x is Computed<unknown> { return typeof x === 'function' && (x as { [COMPUTED]?: true })[COMPUTED] === true }
    /** Signal or computed: what directive paths unwrap. Internal (not in D1). */
    export function isReactive(x: unknown): x is Signal<unknown> | Computed<unknown> {
      return typeof x === 'function' && ((x as { [SIGNAL]?: true })[SIGNAL] === true || (x as { [COMPUTED]?: true })[COMPUTED] === true)
    }
    ```
  - `value.ts`: `import { isReactive } from './signal'`, and `isSignal(cur)` → `isReactive(cur)` at :24, :34 and :42. A computed hop must still unwrap, as it does today through `'peek' in`.
  - Apply R1: `test/build.test.ts:5` name `… under 17 KB (minified)`, `:13` `17 * 1024`; `README.md:5` `bundle < 17 KB minified`.
- [ ] **Step 3: Verify.**
  - `bun test` → `54` old + the new tests pass, `0 fail`.
  - `bun run typecheck` → `No type errors`.
  - `bun scripts/build.ts` → `[build] dist/index.js ~14400 bytes`.
  - Microbench: copy `/private/tmp/claude-501/-Users-detoro-code-brust/a8280810-2b60-4e66-a1d6-2739300c5cfe/scratchpad/bench-sig.ts` to `$OUT`, then point its two imports at `git show m3f:packages/runtime-dom/src/signal.ts > $OUT/old.ts` and at the lane file. Run it 3 × alternating. Accept new ≤ old + 3%, and paste the numbers.
- [ ] **Step 4:** Commit `feat(runtime-dom): reactive ctx and brands on globalThis — one graph across module copies; cleanups untracked (M3-F D2)`.

### Task 2: `store/serialize.ts`

**Files:** NEW `src/store/serialize.ts`, `test/store/serialize.test.ts`.

- [ ] **Step 1: Failing tests** (ported from 0.1.x `serialize.test.ts`; the module does not exist yet, so the file is red):
  1. `toScriptJson round-trips via JSON.parse`
  2. `a value containing </script> emits no literal </script>`
  3. `<!--, &, U+2028, U+2029 are escaped`. Write the inputs as `'\u2028'`/`'\u2029'` escapes in the test source (0.1.x has the raw characters).
  4. `storeScriptTag returns a typed json script tag`: `storeScriptTag('team', { x: 1 })` === `'<script type="application/json" data-brust-store="team">{"x":1}</script>'`
  5. `parseStoreScript reads JSON.parse(el.textContent)`
  6. `parseStoreScript returns {} on invalid JSON without throwing`
  7. NEW `storeScriptTag strips characters outside [A-Za-z0-9_.:-] from the name`: `storeScriptTag('a"b c', 1)` contains `data-brust-store="abc"`.
  8. NEW `C4 golden bytes` (the string the server lane's Rust test must equal byte for byte): `storeScriptTag('cart', { n: '</script><!--&\u2028' })` === `'<script type="application/json" data-brust-store="cart">{"n":"\\u003c/script\\u003e\\u003c!--\\u0026\\u2028"}</script>'`.
- [ ] **Step 2: Implementation.** Port 0.1.x `serialize.ts` verbatim (`ESC` table, `toScriptJson`, `storeScriptTag` with `/[^a-zA-Z0-9_.:-]/g`, `parseStoreScript` with `console.warn('[brust] store: invalid snapshot JSON', e)` and `{}`). Two changes:
  - `ESC[c]!` for `noUncheckedIndexedAccess` (`tsconfig.json:4`);
  - the header comment names C4 and says the Rust emitter mirrors these bytes.

  Run the U+2028 grep from Evidence → no output.
- [ ] **Step 3:** `bun test test/store/serialize.test.ts` → 8 pass; typecheck. Commit `feat(runtime-dom): store snapshot serialization — toScriptJson, storeScriptTag, parseStoreScript (M3-F D6/C4)`.

### Task 3: `store/registry.ts`: browser registry, lazy seed, server-resolver hook

**Files:** NEW `src/store/registry.ts`, `test/store/registry.test.ts`.

**Hook contract for the SERVER lane** (exported from `@brust/runtime-dom/store/internal`, Task 6):
```ts
export interface StoreInstanceRecord {
  instance: object                                   // what the factory returned (signals, computeds, actions)
  subs: Set<() => void>                              // store-level subscribers (useStore)
  version: { n: number }                             // bumped on every real signal write
  snap: { value: Record<string, unknown>; version: number } | null   // memoized snapshot()
  handle?: { serialize(): Record<string, unknown> }  // set on records created for a resolver
}
export type ServerResolver = (name: string, create: () => StoreInstanceRecord) => StoreInstanceRecord
/** Installed once at worker boot by packages/brust/src/store/server-context.ts; null uninstalls (tests). */
export function __setServerResolver(fn: ServerResolver | null): void
```
Semantics the server lane relies on:
- with a resolver installed, EVERY store access calls it (R4);
- `create()` returns a fresh record whose `handle.serialize()` is the store's `serialize()`, so the 0.1.x `getServerInstance` and `collectSnapshot` (`server-context.ts:19-41`) port with only the import path changed;
- outside a scope, the resolver throws `store '<name>' accessed outside a request scope` (R3).

- [ ] **Step 1: Failing tests** (happy-dom is preloaded by `test/setup.ts`, so `document` exists; `afterEach(() => { __setServerResolver(null); _resetStores(); document.body.innerHTML = '' })`). The records are built by a tiny inline `create` here; the `defineStore`-level ports come in Task 4.
  1. `first access creates the record once in globalThis[Symbol.for('brust.stores')]`: `resolveRecord` twice → same object, `create` called once.
  2. `first access seeds from script[data-brust-store=NAME]`: `seed` gets `{ handle: 'ash' }`. A tag for another name is ignored, and a second access does not re-seed.
  3. `bad snapshot JSON seeds nothing and warns`.
  4. `a name with selector metacharacters still finds its tag`: the name `a.b:c` is matched by attribute comparison, not by building a selector.
  5. `an installed resolver takes every access, even with a document present (R4)`: the resolver receives `name` and `create`, and `create()` is called with the server flag.
  6. `no resolver and no document throws "store 'x' accessed on the server without a request scope"`. Temporarily `const d = globalThis.document; delete (globalThis as any).document`, then restore it in `finally`.
  7. `applyStoreSnapshot sets known signals of live records and skips unknown names and keys` (reserved for D9; tested only here).
- [ ] **Step 2: Implementation:**
  ```ts
  import { parseStoreScript } from './serialize'
  const STORES = Symbol.for('brust.stores')                                   // C7
  type Registry = Record<string, StoreInstanceRecord>
  let serverResolver: ServerResolver | null = null
  export function __setServerResolver(fn: ServerResolver | null): void { serverResolver = fn }
  function browserRegistry(): Registry {
    const g = globalThis as { [STORES]?: Registry }
    return (g[STORES] ??= Object.create(null) as Registry)
  }
  function seedScript(name: string): Element | null {          // attribute compare: no selector injection
    for (const el of Array.from(document.querySelectorAll('script[data-brust-store]')))
      if (el.getAttribute('data-brust-store') === name) return el
    return null
  }
  export function resolveRecord(
    name: string,
    create: (server: boolean) => StoreInstanceRecord,
    seed: (rec: StoreInstanceRecord, state: Record<string, unknown>) => void,
  ): StoreInstanceRecord {
    if (serverResolver) return serverResolver(name, () => create(true))
    if (typeof document === 'undefined') throw new Error(`store '${name}' accessed on the server without a request scope`)
    const reg = browserRegistry()
    let rec = reg[name]
    if (!rec) {                                     // first access per page: create, then lazy seed (D6)
      rec = reg[name] = create(false)
      const el = seedScript(name)
      if (el) seed(rec, parseStoreScript(el))
    }
    return rec
  }
  export function applyStoreSnapshot(snap: Record<string, Record<string, unknown>>): void { /* 0.1.x client-hydrate.ts:2-15, reading globalThis[STORES] */ }
  export function _resetStores(): void { delete (globalThis as { [STORES]?: unknown })[STORES] }
  ```
  The resolver stays module-local, as in 0.1.x. A second runtime-dom copy on the SERVER therefore has no resolver and throws loudly; it never leaks state (risk 3).
- [ ] **Step 3:** 7 pass; typecheck. Commit `feat(runtime-dom): store registry on globalThis with lazy seeding and the server-resolver hook (M3-F D3/D6/C7)`.

### Task 4: `store/define-store.ts`

**Files:** NEW `src/store/define-store.ts`, `test/store/define-store.test.ts`.

- [ ] **Step 1: Failing tests.**
  - Server-path ports from 0.1.x `define-store.test.ts`. These run under a test-local stand-in for `runInStoreContext`:
    ```ts
    let scope: Map<string, StoreInstanceRecord> | null = null
    const inScope = <T>(fn: () => T): T => { scope = new Map(); try { return fn() } finally { scope = null } }
    beforeEach(() => __setServerResolver((name, create) => {
      if (!scope) throw new Error(`store '${name}' accessed outside a request scope`)
      let r = scope.get(name); if (!r) { r = create(); scope.set(name, r) }; return r
    }))
    afterEach(() => { __setServerResolver(null); _resetStores(); document.body.innerHTML = '' })
    ```
    1. `proxy reads the active instance signal handle and calls methods`
    2. `serialize includes signal values, excludes computed + functions`
    3. `hydrate sets the signal; snapshot reflects it; computed is evaluated value`: also pass an unknown key `nope: 1`, which must be ignored (D1).
    4. `snapshot is referentially stable until a write`
    5. `subscribe fires on write within the scope`
    6. `no-op .set does not fire subscribers and keeps snapshot reference stable`
    7. `RESERVED blocks a 'then' signal so the handle is not an accidental thenable`: write `await Promise.resolve(store as unknown)`, since the uncast form fails `bun check` (TS2769, seen in the prototype).
  - Browser-registry ports from 0.1.x `client-singleton.test.ts` (resolver set to `null` in the test body):
    8. `two distinct defineStore handles share the same window registry instance`. v2 meaning: the instance lives in `globalThis[Symbol.for('brust.stores')]`; assert `a.n()`/`b.n()` and the fired count.
    9. `first client access hydrates from injected <script data-brust-store>`: `profile.handle() === 'ash'`, `snapshot().upper === 'ASH'`.
  - New, from spec §4 and D1:
    10. `first factory wins per name`
    11. `serialize drops undefined and function signal values`
    12. `serialize throws naming the store and key for a BigInt`: the message contains `store 'big'` and `'n'`.
    13. `server path outside a scope throws "outside a request scope"`
    14. `a write inside an effect does not subscribe the effect to the written signal`: the bridge reads with `peek()` (see Step 2).
- [ ] **Step 2: Implementation.** Port 0.1.x `define-store.ts:28-178`:
  - Keep from 0.1.x: `StoreValue`, `Snapshot<S>`, `RESERVED` (C8), the `StoreHandle<S>` interface, `bridgeSubscribers`, the proxy. The record creation and resolution go through Task 3 instead.
  ```ts
  import { type Computed, type Signal, isComputed, isSignal } from '../signal'
  import { resolveRecord, type StoreInstanceRecord } from './registry'
  function bridgeSubscribers(instance: Record<string, unknown>, subs: Set<() => void>, version: { n: number }): void {
    for (const key of Object.keys(instance)) {
      const sig = instance[key]
      if (!isSignal(sig)) continue
      const origSet = sig.set.bind(sig)
      sig.set = (next) => {
        const before = sig.peek()                 // peek, not sig(): 0.1.x read with sig(), which subscribes a running effect (test 14)
        origSet(next as never)
        if (Object.is(before, sig.peek())) return
        version.n += 1
        for (const cb of Array.from(subs)) cb()
      }
    }
  }
  export function hydrateRecord(rec: StoreInstanceRecord, state: Record<string, unknown>): void {
    const inst = rec.instance as Record<string, unknown>
    for (const key of Object.keys(state)) { const v = inst[key]; if (isSignal(v)) v.set(state[key]) }   // unknown keys ignored
  }
  export function defineStore<S extends object>(name: string, factory: () => S): StoreHandle<S> & S {
    const create = (server: boolean): StoreInstanceRecord => {
      const instance = factory() as Record<string, unknown>
      const rec: StoreInstanceRecord = { instance, subs: new Set(), version: { n: 0 }, snap: null }
      bridgeSubscribers(instance, rec.subs, rec.version)
      if (server) rec.handle = handle            // collectSnapshot() serializes through it
      return rec
    }
    const resolve = () => resolveRecord(name, create, hydrateRecord)
    const handle = (() => resolve().instance) as StoreHandle<S> & S
    Object.defineProperty(handle, 'name', { value: name })
    handle.subscribe = (cb) => { const rec = resolve(); rec.subs.add(cb); return () => { rec.subs.delete(cb) } }
    handle.snapshot = () => { /* 0.1.x :144-156 verbatim: memo by rec.version.n; signals + computeds evaluated */ }
    handle.serialize = () => {
      const out: Record<string, unknown> = {}
      for (const [k, s] of Object.entries(resolve().instance)) {
        if (!isSignal(s)) continue
        const v = s.peek()
        if (v === undefined || typeof v === 'function') continue                 // spec §4
        if (typeof v === 'bigint') throw new TypeError(`store '${name}': '${k}' holds a BigInt, which JSON cannot carry`)
        out[k] = v
      }
      return out
    }
    handle.hydrate = (state) => hydrateRecord(resolve(), state)
    return new Proxy(handle, { get(target, prop, recv) {
      if (typeof prop === 'symbol' || RESERVED.has(prop)) return Reflect.get(target, prop, recv)
      return (resolve().instance as Record<string, unknown>)[prop]
    } })
  }
  ```
  - A BigInt nested inside an object is not detected here. It surfaces where the server lane calls `JSON.stringify`, and that lane names the store there. Say so in the task note for the server lane.
  - Do NOT call `JSON.stringify` per key: it doubles the serialization work on every request.
- [ ] **Step 3:** 14 pass; the old 54 pass; typecheck. Commit `feat(runtime-dom): defineStore — the 0.1.x handle on the shared core and registry (M3-F D1/C8)`.

### Task 5: `store/react.ts` and React as a peer

**Files:** NEW `src/store/react.ts`, `test/store/react.test.ts`; `packages/runtime-dom/package.json`; `bun.lock`.

- [ ] **Step 1: Dependencies, before writing the test.**
  - React is not hoisted: the root `node_modules/` holds only `@types/bun`. It resolves from `packages/brust/node_modules`, which links `node_modules/.bun/react@19.3.0`. So runtime-dom must declare it itself, as a peer plus devDependencies, and never as a dependency. A hard dependency could install a second React next to the app's, and hooks then break (the 0.1.x dual-React trap).
    ```json
    "peerDependencies": { "react": "^19.0.0" },
    "peerDependenciesMeta": { "react": { "optional": true } },
    "devDependencies": { …existing…, "react": "^19.2.0", "react-dom": "^19.2.0", "@types/react": "^19.2.0", "@types/react-dom": "^19.2.0" }
    ```
    The ranges are the ones in `packages/brust/package.json:46-54`, which resolve to the same store entries (`bun.lock:422,424,536,538`). The peer is optional because the main entry is react-free.
  - Run `bun install` at the lane root. `git diff bun.lock` must touch only the `packages/runtime-dom` workspace block. Then `bun install --frozen-lockfile` → no changes.
- [ ] **Step 2: Failing tests** (`renderToString` from `react-dom/server`, NOT `react-dom/client`, as 0.1.x `react.test.ts:3-10` explains):
  1. `useStore renders the store snapshot and reflects writes; server snapshot matches`: ported. It runs on the browser registry, because happy-dom provides `document` and no resolver is set. Expect `>0</span>`, then after `bump()` `>1</span>` and `team.snapshot().score === 1`.
  2. NEW `useStore during SSR outside a request scope renders {} instead of throwing` (D8): install a resolver that throws, then `renderToString(<b>{String(s.n)}</b>)` === `'<b>undefined</b>'`.
  3. NEW `react.ts has no value import from the core`: read the file source and assert that every `from '../…'` / `from './…'` import line starts with `import type` (R2 safety).
- [ ] **Step 3: Implementation** (0.1.x `react.ts`, with the comment rewritten for v2):
  ```ts
  // React bridge (D8). React is a PEER of @brust/runtime-dom, imported only here; src/index.ts never
  // reaches this file, so the runtime bundle stays react-free (scripts/build.ts:7). Type-only import
  // from the core: bundling this file into an island adds no second core (R2).
  import { useSyncExternalStore } from 'react'
  import type { Snapshot, StoreHandle } from './define-store'
  export function useStore<S extends object>(store: StoreHandle<S> & S): Snapshot<S> {
    const serverSnapshot = (): Snapshot<S> => { try { return store.snapshot() } catch { return {} as Snapshot<S> } }
    return useSyncExternalStore(store.subscribe, store.snapshot, serverSnapshot)
  }
  ```
- [ ] **Step 4:** 3 pass; typecheck. `bun scripts/build.ts` still prints no `react leaked` error. Commit `feat(runtime-dom): useStore via useSyncExternalStore; react as an optional peer (M3-F D8)`.

### Task 6: Public surface: `store/index.ts`, `store/internal.ts`, `src/index.ts`, subpath exports

**Files:** NEW `src/store/index.ts`, `src/store/internal.ts`, `test/store/exports.test.ts`; `src/index.ts`; `package.json` (`exports`); `README.md`.

- [ ] **Step 1: Failing test** (`test/store/exports.test.ts`):
  1. `@brust/runtime-dom/store exports exactly the D1 values`: `Object.keys(await import('@brust/runtime-dom/store')).sort()` equals `['batch','computed','defineStore','effect','isComputed','isSignal','signal','untracked']`.
  2. `the runtime entry re-exports every D1 value by identity`: for each key, `index[k] === store[k]`. This is the precondition for C6 aliasing `@brust/core/store` to the runtime URL.
  3. `@brust/runtime-dom/store/react exports useStore`.
  4. `@brust/runtime-dom/store/internal exports the server hook and helpers`: `__setServerResolver`, `applyStoreSnapshot`, `hydrateRecord`, `toScriptJson`, `storeScriptTag`, `parseStoreScript`.
  5. `the runtime entry does not reach react`: `Bun.build` of `src/index.ts` with `external: ['react']` has no `react` import in its output.

  The package self-references resolve through `exports` from inside the package, as `packages/brust/test/package-name.test.ts:6` does. If `@brust/runtime-dom/store` does not self-resolve under the isolated linker, import `../../src/store/index` and assert the `package.json` `exports` map separately. Say which in the note.
- [ ] **Step 2: Implementation.**
  ```ts
  // src/store/index.ts: the D1 surface, nothing else (aliasable to the runtime URL, C6)
  export { signal, computed, effect, batch, untracked, isSignal, isComputed } from '../signal'
  export type { Signal, Computed, Dispose } from '../signal'
  export { defineStore } from './define-store'
  export type { StoreHandle, Snapshot } from './define-store'
  // src/store/internal.ts: server and later-wave plumbing; never documented, never aliased
  export { __setServerResolver, applyStoreSnapshot } from './registry'
  export type { ServerResolver, StoreInstanceRecord } from './registry'
  export { hydrateRecord } from './define-store'
  export { toScriptJson, storeScriptTag, parseStoreScript } from './serialize'
  // src/index.ts: line 1 becomes the D1 values, plus defineStore
  export { signal, computed, effect, batch, untracked, isSignal, isComputed } from './signal'
  export type { Signal, Computed, Dispose } from './signal'
  export { defineStore } from './store/define-store'
  export type { StoreHandle, Snapshot } from './store/define-store'
  // …existing lines 3-7 unchanged
  ```
  `package.json` `exports` uses the same `types`/`default` form as `"."`:
  ```json
  "./store":          { "types": "./src/store/index.ts",    "default": "./src/store/index.ts" },
  "./store/react":    { "types": "./src/store/react.ts",    "default": "./src/store/react.ts" },
  "./store/internal": { "types": "./src/store/internal.ts", "default": "./src/store/internal.ts" }
  ```
  `"files": ["src"]` already ships `src/store`.

  Why `./store/internal` exists:
  - The spec names only `./store` and `./store/react`. `./store/internal` keeps `__setServerResolver` out of the D1 surface (0.1.x `store/index.ts` did not export it either).
  - It keeps `./store` byte-equivalent to what the runtime URL exports, so the server lane's alias stays exact.
  - Record this in the task note for the lead.

  README: a "Store" section listing the D1 surface, the subpaths, lazy seeding from `<script data-brust-store>`, the registry key, and "React is an optional peer, used only by `./store/react`".
- [ ] **Step 3:**
  - `bun test` → all pass.
  - `bun scripts/build.ts` → `[build] dist/index.js ~16400 bytes` (≤ 17,408, R1).
  - Typecheck.
  - Commit `feat(runtime-dom): ./store, ./store/react, ./store/internal subpaths; runtime entry re-exports the store (M3-F §2.1)`.

### Task 7: `@brust/core/store` and `@brust/core/store/react`

**Files:** NEW `packages/brust/src/store/index.ts`, `packages/brust/src/store/react.ts`, `packages/brust/test/store-exports.test.ts`; `packages/brust/package.json` (`exports`).

- [ ] **Step 1: Failing test** (`store-exports.test.ts`):
  1. `@brust/core/store re-exports the runtime-dom store by identity`: every D1 key satisfies `core[k] === rd[k]`, and the key set is exactly D1, so no `__setServerResolver`.
  2. `@brust/core/store/react re-exports useStore by identity`.
  3. `two handles from @brust/core/store and @brust/runtime-dom/store share one store` (D3 second line): `defineStore('x-core', f)` from each specifier, then a write through one is visible through the other.

  The existing `test/package-name.test.ts:6` must also resolve the two new keys; that comes free once they are in `exports`.
- [ ] **Step 2: Implementation:**
  ```ts
  // packages/brust/src/store/index.ts: the documented import (D1). Server-side plumbing lives in
  // ./server-context.ts (SERVER lane), never re-exported here.
  export { signal, computed, effect, batch, untracked, isSignal, isComputed, defineStore } from '@brust/runtime-dom/store'
  export type { Signal, Computed, Dispose, StoreHandle, Snapshot } from '@brust/runtime-dom/store'
  // packages/brust/src/store/react.ts
  export { useStore } from '@brust/runtime-dom/store/react'
  ```
  ```json
  "./store": "./src/store/index.ts",
  "./store/react": "./src/store/react.ts",
  ```
  Insert these after `"./server"` (`package.json:20`). Do NOT add a `browser` condition: both files are isomorphic.

  `@brust/core/store` is not matched by the server-only guard (`bundle.ts:103,128`; `:103` is the server lane's to fix), so browser builds resolve it through `exports` today.
- [ ] **Step 3:** `cd packages/brust && bun run typecheck && bun test test/package-name.test.ts test/store-exports.test.ts` → all pass. Commit `feat(core): @brust/core/store and @brust/core/store/react (M3-F D1)`.

### Task 8: Gates, evidence, READY

- [ ] **Step 1: Gates** (all green, pasted):
  - `cd packages/runtime-dom && bun run typecheck && bun test && bun scripts/build.ts`: old 54 + new pass, `0 fail`, size ≤ 17,408.
  - `cd packages/brust && bun run typecheck && bun test test/package-name.test.ts test/store-exports.test.ts test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts`.
  - `cd packages/brust && bun run build:debug && bun test --timeout 120000 test/e2e.test.ts`. The runtime bundle (`bundle.ts:194`) now carries the store, and the e2e builds and serves it.
  - `cargo test -p brust-compiler --test dual_eval`. Its harness imports the core from `packages/runtime-dom/src/index.ts` (`crates/brust-compiler/tests/harness/rt.ts:3`).
  - `bun run browser-test`, which mounts `packages/runtime-dom/src/index.ts` (`tests/browser/harness.ts:17`).
  - `cd examples/pokedex && bun test && bun run typecheck`.
  - `bun install --frozen-lockfile` at the lane root → no changes.
  - Boundary check: `git diff --name-only m3f` lists only Boundary paths.
  - `grep -nP '\x{2028}|\x{2029}' packages/runtime-dom/src/store/*.ts` → nothing.
- [ ] **Step 2:** Re-run the Task 1 microbench (3 alternating rounds) and paste the numbers.
- [ ] **Step 3:** Post READY (template below). Do not merge; the lead merges into `m3f`.

## Test map (spec §6 → v2)

| 0.1.x file (names verbatim) | v2 file | lane |
|---|---|---|
| `runtime/store/signal.test.ts` (13) | `packages/runtime-dom/test/store/signal.test.ts` (13 + nested-cleanup) | core T1 |
| (spec "brands via Symbol.for across two module instances") | `packages/runtime-dom/test/store/two-copies.test.ts` | core T1 |
| `runtime/store/serialize.test.ts` (6) | `packages/runtime-dom/test/store/serialize.test.ts` (6 + 2) | core T2 |
| `runtime/store/client-singleton.test.ts` (2) | `packages/runtime-dom/test/store/define-store.test.ts` #8–9 (+ registry.test.ts) | core T3/T4 |
| `runtime/store/define-store.test.ts` (7) | `packages/runtime-dom/test/store/define-store.test.ts` #1–7 (+5) | core T4 |
| `runtime/store/react.test.ts` (1) | `packages/runtime-dom/test/store/react.test.ts` (1 + 2) | core T5 |
| `runtime/store/server-context.test.ts` (4): `runInStoreContext runs fn with a fresh map; getServerInstance creates once per scope`, `getServerInstance outside any scope throws "outside a request scope"`, `collectSnapshot returns {name: serialized} for touched stores; null if none`, `INTERLEAVE ISOLATION (S6): two scopes awaiting between mutations do not cross-contaminate` | `packages/brust/test/store-server-context.test.ts` | **server** (uses Task 3's hook) |
| `runtime/render/inject-store.test.ts` (7): `buildStoreScripts equals storeScriptTag per store (native injection contract)`, `buildStoreScripts returns empty string for null / empty snapshot`, `null snapshot → body unchanged (same reference)`, `empty snapshot → body unchanged`, `one store → output contains data-brust-store before </head>`, `no </head> → body unchanged (warn-once)`, `multi-store snapshot → one <script> per store, all before </head>` | Rust tests on `render.rs::inject_assets_into` (v2 variant: before the runtime tag) | **server** (bytes = Task 2 test 8) |

## Review Focus

1. **One graph across copies (T1).**
   - `ctx` is read from `globalThis[Symbol.for('brust.reactive.ctx')]` exactly once per module load (`??=`), and every former use of `currentSub`/`batchDepth`/`pending` goes through it. `grep -nE '\b(currentSub|batchDepth|pending)\b' src/signal.ts` shows no bare module-level `let`/`const` of those names.
   - The two-copies test proves tracking, batching and brands across instances.
   - The ctx shape is exactly `{ currentSub, batchDepth, pending }`, with no version-specific fields.
2. **Directive behaviour unchanged (T1).**
   - `isSignal` is now signal-only (0.1.x). `value.ts` uses `isReactive` at all three sites, so a computed hop still unwraps.
   - `model.ts:10` still rejects a computed.
   - The 54 existing tests, `dual_eval` and `browser-test` are green with no assertion change except the R1 cap.
   - The only intended behaviour change is that cleanups run with `ctx.currentSub = null` (nested-cleanup test).
3. **Resolution order and the hook (T3/T4).**
   - Resolver first, then the browser registry (only when `document` exists), else the 0.1.x throw (R4).
   - Lazy seeding happens on the FIRST access per name only, and matches the tag by attribute comparison.
   - `__setServerResolver(fn | null)` and `StoreInstanceRecord` have exactly the signatures in Task 3, so the server lane ports `server-context.ts` with only an import change.
4. **Handle semantics (T4).**
   - Ported verbatim: RESERVED (C8), snapshot memoized by version, serialize over top-level signals only, hydrate ignoring unknown keys, first factory wins.
   - Deliberate deviations, each pinned by a test: the bridge reads with `peek()`; serialize skips `undefined` and functions and throws on a top-level BigInt.
5. **React stays out of the runtime (T5/T6).**
   - `react.ts` imports only `react` and types.
   - React is an optional peer plus a dev dependency of runtime-dom, never a dependency.
   - `bun.lock` changes only in the runtime-dom block.
   - `@brust/runtime-dom/store` and `@brust/core/store` export exactly the D1 values; `internal` is not re-exported anywhere public.
   - Bundle ≤ 17 KB, react-free.

## Risk ledger

| # | Risk | Mitigation |
|---|---|---|
| 1 | The bundle-size cap breaks (14,401 B with the core change alone) | Ruling R1 (17 KB) before dispatch; size pasted at T1, T6 and READY |
| 2 | C6 as written aliases `@brust/core/store/react` to a react-free runtime, so the island `useStore` import fails at load | R2 challenge filed at lane start. `react.ts` is type-only toward the core, so either resolution is safe for state; the server lane owns the fix |
| 3 | A second runtime-dom copy on the SERVER (e.g. `jobs.js` bundling `@brust/runtime-dom` because `JOBS_EXTERNALS`, `bundle.ts:281`, lists only `@brust/core*`) has no resolver | It fails loudly (R4: no document → throw) and never leaks across requests. A note for the server lane: add `@brust/runtime-dom`, `@brust/runtime-dom/*` to `JOBS_EXTERNALS` |
| 4 | Changing `isSignal` semantics breaks a consumer that relied on `'peek' in` | `grep` found only `value.ts` and `model.ts` (in-boundary); the compiler emits no `isSignal` (`crates/` grep is empty); `dual_eval` + `browser-test` are gates |
| 5 | Raw U+2028/2029 written into `serialize.ts` → `Syntax Error` | Escapes only; grep gate in T2 and READY |

## Dispatch table

Lane tier: standard (one implementer; tasks are sequential in one worktree) · review: complex (Review Focus 1–5).

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3f-store-core-1` core ctx + brands | standard | implementer | lane created; R1 answered; R2 challenge filed | red names pasted; `cd packages/runtime-dom && bun test` all pass (54 old untouched except R1 cap); `bun run typecheck` clean; `bun scripts/build.ts` ≈14.4 KB ≤ 17 KB; microbench new ≤ old +3% (3 rounds); commit |
| `m3f-store-core-2` serialize | standard | implementer | 1 | 8 serialize tests pass incl. C4 golden; U+2028 grep empty; typecheck; commit |
| `m3f-store-core-3` registry + hook | standard | implementer | 2 | 7 registry tests pass (lazy seed once, attribute match, resolver-first, no-doc throw, applyStoreSnapshot); hook signatures exactly as Task 3; commit |
| `m3f-store-core-4` defineStore | standard | implementer | 3 | 14 define-store tests pass (7 ported + 2 client-singleton ports + 5 new); old 54 pass; typecheck; commit |
| `m3f-store-core-5` useStore + peer | standard | implementer | 4 | 3 react tests pass; `git diff bun.lock` only the runtime-dom block; `bun install --frozen-lockfile` clean; build reports no react leak; commit |
| `m3f-store-core-6` exports | standard | implementer | 5 | exports test pass (D1 key set exact, identity with index, internal surface); `dist/index.js` ≤ 17,408 B pasted; README Store section; commit |
| `m3f-store-core-7` @brust/core subpaths | standard | implementer | 6 | `cd packages/brust && bun run typecheck && bun test test/package-name.test.ts test/store-exports.test.ts` pass; commit |
| `m3f-store-core-8` gates + READY | standard | implementer | 7 | all Task 8 gates pasted (runtime-dom, brust units + e2e, dual_eval, browser-test, pokedex, frozen lockfile, boundary diff, U+2028 grep); microbench; READY posted |

## READY note template

```
READY lane/m3f-store-core @ <sha> (base m3f @ 3342353)
rulings: R1 <accepted/…> (cap 17 KB) · R2 challenge <id> <status> · R3 0.1.x strings · R4 resolver-first
runtime-dom: bun test <N> pass / 0 fail (54 pre-existing unchanged; build.test.ts cap only) · typecheck clean · dist/index.js <bytes> B (was 13,900)
new tests: signal 14 · two-copies 1 · serialize 8 · registry 7 · define-store 14 · react 3 · exports 5 · core store-exports 3
core: @brust/core/store + /store/react resolve (package-name.test) · identity with runtime-dom
microbench (set→computed→effect, ms/run, old→new ×3): <a→b> <a→b> <a→b> (Δ <x>%)
gates: brust units <paste> · e2e <paste> · dual_eval <paste> · browser-test <paste> · pokedex <paste> · frozen-lockfile clean · boundary diff clean · U+2028 grep empty
hook for m3f-store-server: import { __setServerResolver, hydrateRecord, type StoreInstanceRecord, type ServerResolver } from '@brust/runtime-dom/store/internal' — signatures per plan Task 3; resolver must throw "store '<name>' accessed outside a request scope"
notes for server lane: C4 golden (serialize test 8) · nested BigInt surfaces at your JSON.stringify — name the store · add @brust/runtime-dom(/*) to JOBS_EXTERNALS (risk 3) · store/react stays bundled in islands (R2)
deviations from 0.1.x (each test-pinned): bridge uses peek(); serialize skips undefined/functions and throws on top-level BigInt; cleanups untracked in nested flush; resolver-first order; conditional self-write settles by recursion (no re-entrancy guard, D2)
```
