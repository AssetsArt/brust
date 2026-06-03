# Native store-snapshot SSR injection (B7) — implementation plan

Spec: `2026-06-03-native-store-snapshot-ssr-design.md` · Branch: `feat/b6-dx-hardening`

Three tasks, strict sequence. Each is TDD: failing test first, watch it fail,
minimal code, watch it pass. Rebuild the napi addon after the Rust change
(`cd runtime && bun run build:debug`) before any TS test that boots a server.

## Spec coverage map

| Spec section | Task |
|---|---|
| Touch point 1 — compiler slot in Document `<head>` | Task 1 |
| Tests §1 — compiler golden | Task 1 |
| Tests §2 — `buildStoreScripts` contract lock | Task 2 |
| Touch point 2 — `routes.ts` native branch wiring | Task 3 |
| Tests §3/§4 — runtime integration + hydration parity | Task 3 |
| Acceptance: fast lane unchanged, gates green | Task 3 (final gate run) |

---

## Task 1 — Compiler emits the `__brust_store__` slot (Rust)

**File:** `crates/jsx-rust-compiler/src/emit_jinja.rs`

### RED
Add a unit test in the `emit_jinja.rs` test module (near the existing Document
emit tests). It builds a minimal `JsxNode::Document` and asserts the emitted
string contains `{{ __brust_store__ | safe }}` positioned **after** the app.css
`<link ... app.css ...>` and **before** `</head>`. Find the existing Document
emit test to copy its construction; if the test module builds Documents via a
helper, reuse it.

Assertion shape:
```rust
let out = /* emit a Document */;
let link = out.find("/_brust/css/app.css").unwrap();
let slot = out.find("{{ __brust_store__ | safe }}").expect("store slot emitted");
let head_close = out.find("</head>").unwrap();
assert!(link < slot && slot < head_close, "slot must sit after app.css link, before </head>: {out}");
```

Run: `cargo test -p jsx-rust-compiler emit` → MUST fail (slot not emitted yet).

### GREEN
In the `JsxNode::Document` arm, immediately before `out.push_str("</head><body");`
(line ~151, after the `for entry in head { … }` loop), insert:
```rust
// B7 store-snapshot SSR: a framework-owned slot the JS native renderer fills
// with the defineStore snapshot <script>(s) (empty string when no store was
// touched). RAW — framework-controlled markup, not a user value; brust's
// minijinja is AutoEscape::None so `| safe` is documentation of intent.
out.push_str("{{ __brust_store__ | safe }}");
```

Run: `cargo test -p jsx-rust-compiler` → the new test passes.

### Golden fallout (EXPECTED)
The slot changes the emitted `.jinja` for every native Document. Run the full
`cargo test --workspace`. Any golden test that compares **emitted template bytes**
will fail and must be updated to include the slot (it is a correct addition).
Golden tests that **render** a template (`crates/brust/tests/golden_render_jinja/`)
are NOT expected to change: `__brust_store__` is undefined in their context and
brust's minijinja (`UndefinedBehavior::Chainable`) renders `{{ undefined | safe }}`
as `''`. If a *rendered* golden changes, STOP — that means the render context does
define `__brust_store__`, which contradicts the spec; re-read before editing.

**BLOCKED fallback:** if updating emitted-template goldens cascades into many
fixtures, that's still mechanical — regenerate them, don't change the slot. If a
*rendered* golden breaks (unexpected), pause and report rather than forcing the
fixture.

### Verify + rebuild napi
```
cargo fmt --all && cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd runtime && bun run build:debug   # so TS server tests use the new compiler
```
Commit: `feat(compiler): emit __brust_store__ slot in native document <head> (B7)`

---

## Task 2 — `buildStoreScripts` contract lock (TS)

**File:** `runtime/render/inject-store.test.ts`

The native path depends on `buildStoreScripts` producing exactly the same tag as
React (`storeScriptTag`) and `''` for the empty cases. Add explicit assertions
(this LOCKS an existing contract — it may pass on first run; that is acceptable
for a contract guard, note it in the commit body):

```ts
import { storeScriptTag } from '../store/serialize.ts'
// …
test('buildStoreScripts equals storeScriptTag per store (native injection contract)', () => {
  expect(buildStoreScripts({ cart: { count: 1 } })).toBe(storeScriptTag('cart', { count: 1 }))
})
test('buildStoreScripts returns empty string for null / empty snapshot', () => {
  expect(buildStoreScripts(null)).toBe('')
  expect(buildStoreScripts({})).toBe('')
})
```

Run: `bun test runtime/render/inject-store.test.ts` → green.
Commit: `test(store): lock buildStoreScripts contract the native path relies on (B7)`

---

## Task 3 — Wire native branch + fixture + integration (TS)

### 3a. Fixture — a native route whose loader writes a defineStore

**Files:** `tests/fixtures/app/` (additive — must not change existing routes' output).

1. A store module, e.g. `tests/fixtures/app/store-counter.ts`:
   ```ts
   import { defineStore } from '../../../runtime/store/index.ts'
   import { signal } from '../../../runtime/store/signal.ts'   // match existing import style
   export const counterStore = defineStore('counter', () => ({ count: signal(0) }))
   ```
   (Confirm the exact `defineStore`/`signal` import paths + factory shape against
   an existing `defineStore` usage in the repo before writing — mirror it.)

2. A native full-document page (BrustPage/Document shell), modeled on an existing
   native fixture page (e.g. `NativeSsrIslandPage.tsx`), e.g.
   `tests/fixtures/app/NativeStorePage.tsx` — minimal `<BrustPage title="store">…</BrustPage>`.

3. A route in `tests/fixtures/app/routes.tsx` with a loader that writes the store:
   ```ts
   { path: '/_test/native-store', native: true, Component: NativeStorePage,
     loader: async () => { counterStore.count.set(42); return {} } }
   ```
   (Match the existing native-route registration shape in that file.)

**Verify the fixture builds:** the route must compile as native. Reuse the
`native-island-ssr.test.ts` harness style (it runs `brust build` on the fixture)
OR assert via the source-mode boot — pick the harness in 3c.

### 3b. GREEN — wire `runtime/routes.ts`

1. Add import: `import { buildStoreScripts } from './render/inject-store.ts'`.
2. Make the native loader closure (~line 740) `async` and capture the snapshot:
   ```ts
   let storeSnapshot: Record<string, Record<string, unknown>> | null = null
   // …
   chainResult = await runInRequestContext(call.req?.cookies ?? {}, async () => {
     const r = await runNativeChainLoaders(flat.chain, ctx)
     storeSnapshot = collectSnapshot()
     return r
   })
   ```
3. After `data` is finalized and **before** `const json = JSON.stringify(data)`
   (~line 772):
   ```ts
   if (data && typeof data === 'object') {
     ;(data as Record<string, unknown>).__brust_store__ = buildStoreScripts(storeSnapshot)
   }
   ```

### 3c. RED→GREEN — integration test

Add a test asserting the served native-store route's full HTML contains the store
`<script>` in `<head>` with the loader value, and that a store-less native route
(e.g. `/_test/native-island-ssr`) does NOT contain a `data-brust-store` script.

Preferred harness: **`tests/native-island-ssr.test.ts`** (it runs an explicit
`brust build` on `tests/fixtures/app` then boots — deterministic, build-mode,
avoids source-mode flake). Add the assertions there:
```ts
test('B7: native route loader-written defineStore is injected into <head>', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-store`)
  expect(res.status).toBe(200)
  const html = await res.text()
  const head = html.slice(0, html.indexOf('</head>'))
  expect(head).toContain('data-brust-store="counter"')
  expect(head).toContain('42')                         // the loader-set count
})
test('B7: a native route that touches no store injects no store <script>', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-island-ssr`)
  const html = await res.text()
  expect(html).not.toContain('data-brust-store=')
})
```

Run with napi already rebuilt (Task 1): `bun test tests/native-island-ssr.test.ts`
→ first RED (no injection), then GREEN after 3b.

**BLOCKED fallback:** if the `native-island-ssr` build harness can't see the new
store fixture cleanly (e.g. the store import breaks the bundle), fall back to a
standalone test that runs `brust build` on the fixture into a temp dir + boots
(model on `cli-build.test.ts`'s isolated build). Do NOT weaken the assertion to
make it pass — the head MUST contain the loader value.

### Verify (full gate, run by orchestrator in Phase 6 too)
```
cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings
cd runtime && bun run build:debug
cd .. && bun run ci && bun run typecheck:treaty
bun test runtime/
bun test tests/native-island-ssr.test.ts   # + integration, cli-build, static-assets, native-source-mode separately
```
Commit: `feat(native): inject defineStore snapshot into native SSR <head> (B7)`

---

## Acceptance recap (Phase 6 gate)
- Native full-document route with a store-writing loader → store `<script>` in
  `<head>` with the loader value; store-less native route → none.
- Fast lane unchanged (still `napiRenderJinja` returning a length).
- All gates green; napi rebuilt; no rendered-golden regressions.
