# Native `x-for` SSR — compiler emits `{% for %}` seed + client adopts

> Status: design · 2026-06-04 · FRAMEWORK feature (Rust compiler `crates/jsx-rust-compiler` + TS runtime
> `runtime/native/runtime.ts` + example). Needs napi rebuild + release. Builds on the just-shipped
> keyed `x-for` (0.1.28) + native SSR-import (0.1.29).

## Goal

A native `x-for` list currently renders **client-only**: the compiler passes `<a x-for="…">` through as
a literal element; on load the grid is EMPTY until the directive runtime clones the template per item.
Make the **server render the initial list** (so it's visible immediately, works without/before JS), then
the **client `x-for` adopts** those server-rendered nodes and takes over filtering/sorting on search —
reusing the DOM (no flash, no rebuild).

The user-facing win: `/pokedex` (DexFilter) paints 151 cards server-side; typing in the filter is the
client keyed reconcile reusing those exact nodes.

## High-level design

`x-for` desugars (for SSR) into the compiler's existing `JsxNode::Map` → `{% for %}` machinery
(`emit_jinja.rs:41-48`), while RETAINING the `x-*` client directives on the element so the runtime can
adopt + reconcile.

### Mechanism — one name, two contexts
The `x-for` source binds to ONE name (e.g. `items`) that resolves:
- **server (loader context):** a real array member-path → compiler emits `{% for c in items %}…{% endfor %}`.
- **client (behavior):** a reactive **signal seeded to the same initial data** → search mutates it
  (`items.set(filteredSubset)`), and the keyed `x-for` reconciles.

On first paint the server-rendered list == the client signal's initial value, so adoption is a no-op
reconcile (all reused).

### 1. Compiler (Rust) — `x-for` element → SSR `{% for %}` + retained client attrs
When lowering a native element carrying `x-for="<item> in <source> by <keypaths>"` where `<source>` is a
**member-path resolvable in the template (loader) scope**:
- Emit a `{% for <item> in <source> %} … {% endfor %}` loop around the element (reuse the `Map` emit path).
- INSIDE the loop, render the element + children with the loop binding:
  - `x-text="c.x"` → the element's text becomes `{{ (c.x) | e }}` (server value) — AND keep `x-text="c.x"` as an attr (client).
  - `x-bind-<attr>="c.x"` → emit `<attr>="{{ (c.x) | e }}"` (server value) — AND keep `x-bind-<attr>="c.x"` (client).
  - Add `data-x-key="{{ (<keypath0>) | e }}"` (joined for composite) so the runtime can match SSR nodes to keys.
  - Keep `x-for`/`x-data` context intact so the runtime mounts + adopts.
- The element is emitted ONCE inside the loop (not duplicated): the same element node is BOTH the SSR
  per-item render (via the for-loop) AND carries the client `x-*` attrs. The runtime treats the loop
  output as the adopt seed; the FIRST such node (or a stripped clone) is the template for future creates.
- **Detection:** an `x-for` whose `<source>` is NOT a loader member-path (e.g. a behavior-only computed
  like the old `filtered`) → keep the EXISTING client-only passthrough (no `{% for %}`, backward compat).
  The compiler emits SSR only when the source resolves in the template scope. (A build note/warning when
  an `x-for` is client-only may help authors opt into SSR by exposing a loader array.)

### 2. Runtime (TS) — `bindFor` adopts existing keyed children
`bindFor` (`runtime/native/runtime.ts`, keyed branch) gains an **adopt-on-init** step:
- On first bind, BEFORE the reconcile effect, scan the parent for existing children carrying
  `data-x-key` (the SSR'd seed). For each, create a `ForEntry` adopting that node: `itemSig`/`idxSig`
  seeded from the matching client item (by key), `bindTree(node, childScope, …)` to wire the `x-*`
  reactivity onto the SSR node (effects set the same values it already shows — idempotent), and record
  it in `map` keyed by `data-x-key`.
- Capture the **template** for future creates from a clone of the first adopted node, stripped of
  `data-x-key` + reset to the template shape (or a dedicated hidden template). Then `tplEl`/seed nodes
  stay in the DOM (NOT removed — adopted).
- The first reconcile effect run then finds every key already in `map` → all reused (no clone, no
  flash). Subsequent runs (search) reconcile normally (the 0.1.28 keyed logic).
- **No-`data-x-key` (legacy / client-only x-for):** unchanged — clone-fresh from template as today.

### 3. Example — DexFilter SSR-seeded
- `browseLoader` already provides the items; pass the **array** to the directive as a member-path
  (for the SSR `{% for %}`) in addition to the `data` JSON (client x-props), OR restructure so the
  x-for lives where the loader array is in scope.
- DexFilter behavior: expose `items` as a **signal seeded to all** (matches SSR); `filtered`/sort SET
  `items` to the subset on search (instead of a separate `filtered` computed bound to x-for).
- `x-for="c in items by c.id"`; children keep `x-text`/`x-bind-src`/`x-bind-href` so SSR renders values
  and client re-binds.

## Open design questions → resolved
- **server array identity** ✅ x-for source must be a loader member-path (resolvable in template scope) for
  SSR; else client-only passthrough (backward compat).
- **one name, two contexts** ✅ loader array (server) + behavior signal seeded to same data (client).
- **adopt mechanism** ✅ `data-x-key` on SSR nodes; runtime matches + `bindTree` to wire reactivity.
- **template for future creates** ✅ derived from a stripped clone of an adopted node.

## Non-trivial / risks (call out for review + plan)
- **Compiler: x-for is currently a passthrough attr, not a `Map` node.** The change must detect x-for at
  lower time, decide SSR-vs-client (source resolvable?), and route SSR into the Map-emit path while
  keeping the x-* attrs. Verify how `.map()` becomes `JsxNode::Map` and whether x-for can be desugared
  similarly at lower (`lower.rs`).
- **Bound-children dual render** (server value + retained client attr) — the emit must output BOTH the
  `{{ … }}` value AND the `x-*` attr on the same element/child. Confirm the attr emitter can do both.
- **Markup match for adopt** — the SSR node structure MUST equal what `bindTree` expects (the client
  template), so re-binding sets the same values. Composite keys → `data-x-key` join must match the
  runtime's key computation (`\x00` join).
- **napi rebuild** after the Rust change (`cd runtime && bun run build`), else stale `.node`.
- **No-JS / progressive enhancement**: SSR list is visible + links work without JS (the `<a href>` is
  SSR'd); search needs JS (acceptable).

## Tests
- **Compiler golden** (`jsx-rust-compiler/src/lib.rs` or emit_jinja tests): a native element with
  `x-for="c in items by c.id"` + `x-text`/`x-bind-*` children + loader-array source → emits
  `{% for c in items %}<a data-x-key="{{ (c.id) | e }}" href="{{ (c.detailHref) | e }}" x-bind-href="c.detailHref">…{{ (c.displayName) | e }}…</a>{% endfor %}`. A client-only source (not a loader path) → unchanged passthrough (regression).
- **Runtime** (`runtime/native/runtime.test.ts`): given a parent with SSR'd `data-x-key` children + a
  matching client list → `bindFor` ADOPTS (the exact SSR node objects are reused, NOT replaced — assert
  identity), wires reactivity (changing the item updates the adopted node's `x-text`), and a later
  filter reconciles (removed keys' nodes gone, kept reused). No-`data-x-key` → clone-fresh (regression).
- **Integration / browser smoke**: `/pokedex` SSR HTML contains the 151 `<a data-x-key=…>` cards
  (curl, no JS); after hydrate, typing filters reusing the same `<img>` element identity (the 0.1.28
  proof, now starting from SSR nodes).

## Acceptance criteria
1. `cargo fmt`/`clippy`/`test` green (+ new x-for-SSR goldens); **napi rebuilt**.
2. `bun run ci` (biome) clean; `bun test runtime/` green (baseline 465); `typecheck:treaty` 0.
3. native integration suite green (native-island, cli-build, integration).
4. `/pokedex` server HTML (curl, JS disabled) contains the full card list with real `href`/`src`/text +
   `data-x-key` — captured, not prose.
5. After hydrate, search filters via the keyed reconcile REUSING the SSR nodes (browser smoke: a
   surviving card's `<img>` element identity unchanged from the SSR'd node through a keystroke).
6. Backward compat: a client-only `x-for` (source not a loader path) still works unchanged; existing
   x-for tests green.

## Known limitations / out of scope
- SSR only when the `x-for` source is a loader member-path; a purely client-computed list stays
  client-only (documented; authors opt in by exposing a loader array + a seeded signal).
- Index reactivity on SSR adopt: `idxSig` seeded from position; fine.
- Large datasets SSR'd inline grow the HTML payload (151 cards ≈ fine; not a virtualized list).
