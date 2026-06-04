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
  - **Key attr (NOT `\x00` in markup — spec-review B1):** a literal NUL in an HTML attribute is replaced
    with U+FFFD by the HTML parser, so the runtime `\x00`-join must NEVER appear in markup. Emit:
    single keypath → `data-x-key="{{ (<keypath0>) | e }}"`; composite → ONE attr per part
    `data-x-key-0="{{ (<kp0>) | e }}" data-x-key-1="{{ (<kp1>) | e }}" …`. The runtime reads
    `data-x-key` (single) OR collects `data-x-key-*` in order and joins with `\x00` **in JS** to match
    its computed key. NUL only ever exists in memory, never in HTML.
  - Keep `x-for`/`x-data` context intact so the runtime mounts + adopts.
- The element is emitted ONCE inside the loop (not duplicated): the same element node is BOTH the SSR
  per-item render (via the for-loop) AND carries the client `x-*` attrs. The runtime treats the loop
  output as the adopt seed; the FIRST such node (or a stripped clone) is the template for future creates.
- **NEW x-for source parser (spec-review B2):** `x-for` is currently an OPAQUE `AttrValue::Static`
  string the compiler never parses. This feature adds a Rust mini-parser for the x-for grammar (mirror
  the runtime `parseFor` at `runtime/native/runtime.ts:153`: `(item[,index]) in source by k0, k1`),
  invoked when lowering an element that carries `x-for`. It resolves `<source>` via the existing
  `lower_expr` ident resolution (`lower.rs:2982`).
- **Detection / backward-compat:** route to SSR `{% for %}` ONLY when `<source>` resolves to a
  destructured loader prop (`Field`). When it resolves to `UnresolvedIdent` / `MapBinding` / named-param
  (a behavior-only/client name like the old `filtered`) → **fall back to today's opaque Static-attr
  passthrough, do NOT error** (this is the existing behavior; the new parser must be additive, never
  hard-fail a client-only x-for). Existing client-only x-for + `.map()` paths stay byte-identical.
- **Real attrs for progressive enhancement (spec-review fix):** for `x-bind-<attr>="c.x"` the SSR MUST
  emit the REAL attribute `<attr>="{{ (c.x) | e }}"` (today bound attrs are absent pre-JS — links dead
  without JS). So an `<a x-bind-href>` SSR's a real `href` → the list is navigable with JS disabled.

### 2. Runtime (TS) — `bindFor` keyed-init REWRITE for adopt (spec-review B4)
The current keyed branch is destroy-then-clone: it inserts a comment `anchor`, snapshots
`template = tplEl.cloneNode(true)`, then **`tplEl.remove()`** (`:202-204`) before any reconcile. Adoption
is a REWRITE of that init (not an additive hook):
- Pre-populate `map` by scanning `parent` for `[data-x-key]` (single) / `[data-x-key-0]` (composite)
  children — the SSR seed. Derive each entry's key the SAME way the reconcile does (read `data-x-key`
  or join `data-x-key-*` with `\x00`).
- Derive the `anchor` position from the LAST seed node (not from the removed template).
- Capture `template` for future creates from a stripped clone of the first seed node (drop `data-x-key*`).
- Do NOT `remove()` the seed nodes — adopt them.
Then the adopt-on-init step:
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

### 3. Example — DexFilter RE-ARCHITECTURE (spec-review B3: the current showcase can't SSR)
Today `DexFilter({ data })` binds `x-for="c in filtered by c.id"` where `filtered` is a behavior
`computed` and `data` is a JSON string → the source is NOT a template-scope array, so it can't SSR.
The REQUIRED authoring contract for SSR-seeded x-for:
- The directive's `default` signature destructures a **real array prop** in template scope, e.g.
  `DexFilter({ items, data })` — `items` is the loader array (member-path → SSR `{% for c in items %}`),
  `data` is the client x-props JSON (unchanged).
- `browseLoader` passes BOTH: `<DexFilter native items={browseItems} data={dexProps} />` (`items` a
  member-path array; `dexProps` the JSON string).
- The behavior exposes `items` as a **signal seeded from props.items** (matches the SSR order exactly);
  search/sort call `items.set(subset)` (replacing the `filtered` computed). The x-for binds `c in items`.
- Children keep `x-text="c.displayName"` / `x-bind-src="c.artwork"` / `x-bind-href="c.detailHref"` so SSR
  renders the values + real attrs and the client re-binds on adopt.
This authoring contract (loader-array prop + behavior signal seeded to it, same name) is the documented
way to make any native `x-for` SSR-seeded. (A client-only `x-for` that doesn't follow it stays
client-only — backward compatible.)

## Open design questions → resolved
- **server array identity** ✅ x-for source must be a loader member-path (resolvable in template scope) for
  SSR; else client-only passthrough (backward compat).
- **one name, two contexts** ✅ loader array (server) + behavior signal seeded to same data (client).
- **adopt mechanism** ✅ `data-x-key`(single)/`data-x-key-*`(composite, joined in JS) on SSR nodes; runtime
  matches + `bindTree` to wire reactivity. NUL never in markup.
- **template for future creates** ✅ derived from a stripped clone of an adopted node.
- **x-for source parser + backward-compat** ✅ new Rust parser; SSR only for `Field` (loader-prop)
  sources; `UnresolvedIdent`/`MapBinding`/named → opaque passthrough (no error).
- **progressive enhancement** ✅ x-bind-* SSR real attrs (href/src navigable without JS).
- **index/order invariant** ✅ SSR `{% for %}` source order MUST equal the behavior signal's seed order
  (so `idxSig`-by-scan-position is correct); enforced by both reading the SAME loader array.

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
