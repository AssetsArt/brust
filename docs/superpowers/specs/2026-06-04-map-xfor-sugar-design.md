# Native `.map()` + bare `x-for` → SSR adopt sugar

> Status: design · 2026-06-04 · FRAMEWORK feature (Rust compiler `crates/jsx-rust-compiler`
> `lower.rs` + TS runtime `runtime/native/runtime.ts`). Builds directly on the just-implemented
> native `x-for` SSR (branch `feat/native-xfor-ssr`: `{% for %}` seed + `bindFor` adopt +
> `data-x-key`). Needs napi rebuild.

## Goal

Let authors write an **idiomatic React `.map()`** (with `key={...}`) and opt a single list into the
`x-for` SSR-adopt machinery with one bare `x-for` flag — instead of hand-writing the verbose
`x-for="… by …"` expression plus every `x-bind-*`/`x-text` directive. The compiler derives the
`x-for` expression, `data-x-key`, and the client directives from the `.map()` shape; reactivity stays
opt-in (a behavior signal of the same name); a marked map with **no** backing signal renders as plain
static SSR (never wiped).

The win: `<a x-for key={t.id} href={t.href}>{t.label}</a>` inside a `.map()` is all an author writes;
they get the server-rendered list + (when a signal exists) client adopt + keyed reconcile.

## Non-goals

- **`x-bind-style` / reactive `style` objects** — explicitly DEFERRED to a later feature. In v1 a
  `style={{ … t.x … }}` on a marked element renders its value SSR-static (server value only, not
  re-bound on reconcile). Authors needing reactive per-item style hand-write directives until then.
- Auto-converting EVERY `.map()` — conversion is opt-in per-map via the bare `x-for` flag. An unmarked
  `.map()` stays byte-identical static SSR.
- Composite keys via the sugar — React `key` is a single value; composite keying stays the explicit
  `x-for="… by a, b"` path.
- Changing the explicit `x-for` authoring path (the just-shipped feature) — this is additive sugar that
  reuses the same lowering/runtime.

## High-level design

Three pieces. The `.map()` already lowers to `JsxNode::Map { source, binding, body }` via
`lower_call_as_map` (`lower.rs`); the sugar decorates that Map's body with the adopt directives when the
body element carries a bare `x-for`, then the EXISTING `bindFor` adopt path (already merged) handles the
client side, plus one new static-fallback guard.

### 1. Compiler — bare `x-for` on a `.map()` body element (Rust, `lower.rs`)

In `lower_call_as_map`, AFTER the `JsxNode::Map` is built, inspect the body. If the (root) body element
carries an `x-for` attribute with **no value** (`AttrValue::Empty` — the bare flag, distinct from the
explicit `x-for="…"` Static string), run the sugar transform:

- **Reconstruct the `x-for` expression** from the Map: `binding` (`t`) + `source` name (`typeTiles`,
  from `emit_expr_path(source)` when it's a `Field`/`MemberAccess`) + the key path → emit
  `x-for="t in typeTiles by t.id"` as a `Static` attr (so the runtime `parseFor`/`bindFor` works
  unchanged). Replace the bare `x-for` Empty attr with this reconstructed Static one.
- **Key** — read the element's `key={t.<path>}` attr (currently dropped silently in `lower_attr:2345`;
  here it's captured at the map-body site BEFORE drop, or re-read from the JSX). The key value must be a
  single map-binding member path (`t.id`). Emit `data-x-key="{{ (t.id) | e }}"` (single) on the root.
  A `key` that is NOT a simple `t.<path>` member expr (literal, template string, composite) → **compile
  error** with a message directing the author to the explicit `x-for="… by …"` form. (Do NOT silently
  fall back — a marked map with an underivable key is an authoring mistake worth surfacing.)
- **Auto-convert attrs whose value references the map binding** (`Expr::MapMember`/`MapBinding` rooted
  at `t`): for `href={t.href}` (already lowered to an `Expr` attr that emits the SSR value
  `href="{{ (t.href) | e }}"`), ADD a sibling `x-bind-href="t.href"` (`Static`) for the client to
  re-bind on adopt. React rename applies: `className={t.cls}` → `x-bind-class`. An attr whose value is
  **static** (a literal `className="…"`, not referencing `t`) is left untouched (it never changes per
  item — no directive needed). This is the INVERSE of the explicit-x-for `transform_xfor_element` (which
  reads `x-bind-*` and adds the real attr); here we read the real `Expr` attr and add the `x-bind-*`.
- **Text child** — when the element's children are a SINGLE map-binding expr child (`{t.label}` →
  `JsxNode::Expr(MapMember t.label)`), ADD `x-text="t.label"` (`Static`) on the element (the SSR value
  child stays). Mixed / multiple / element children → leave as static SSR (the inner content is not
  re-bound; documented limitation).
- **`style={{ … }}` object referencing `t`** — leave as the SSR-static value (no `x-bind-style`).
  DEFERRED per Non-goals.
- Detection / backward-compat: only triggers on a bare-`x-for` body element whose Map `source` resolves
  to a real template-scope array path (`Field`/`MemberAccess` via `resolve_xfor_source`, the same helper
  the explicit path uses). A `.map()` over a behavior-computed/non-path source, or with no bare `x-for`,
  is byte-identical to today.

> Architecturally this runs in `lower_call_as_map` (NOT `lower_element`) because only the map call knows
> the `source` (`typeTiles`); `lower_element` sees only the body element. It reuses the existing
> `data-x-key` emit + `set_or_push_attr` dedup helpers.

### 2. Runtime — static fallback guard (TS, `bindForAdopt`)

The just-merged `bindForAdopt` reads `list = read(instance, listPath)`, builds a key index, adopts the
seeds, and installs the keyed reconcile. NEW guard for the "marked map, no backing signal" case (an
author used the flag but no behavior exposes `typeTiles`, or the list is inside an unrelated `x-data`):

- Before adopting, resolve the source non-reactively: `resolveRaw(instance, listPath)`. If it is
  `undefined` (no such property/signal on the instance) → **return early WITHOUT installing the
  reconcile and WITHOUT touching the seed nodes** — the SSR list stays exactly as rendered (fully
  static). Do NOT bind `x-text`/`x-bind-*` either (binding against a missing source would read
  `undefined` and clear the SSR content).
- When `listPath` resolves to a signal/array → unchanged: adopt + reconcile as today.

This makes the bare-`x-for` flag safe to use on a list that only SOMETIMES has a behavior — exactly the
"ไม่ได้มี behavior ตลอด" requirement.

### 3. Example (optional dogfood)

A pokedex `.map()` that is currently static (e.g. the type-chart / home type tiles) can adopt the flag
to demonstrate both modes (static when no behavior; reactive if a behavior is later added). Not required
for the feature; include one small golden + a browser smoke if a natural static-list target exists.

## Tests

- **Compiler golden** (`golden_emit_jinja`):
  - `map_xfor_sugar.tsx` — `{items.map((t) => <a x-for key={t.id} href={t.href}>{t.label}</a>)}` over a
    loader-array prop → `{% for t in items %}<a x-for="t in items by t.id" href="{{ (t.href) | e }}"
    x-bind-href="t.href" data-x-key="{{ (t.id) | e }}"><… x-text="t.label">{{ (t.label) | e }}…</a>{% endfor %}`
    (freeze from REAL emit; eyeball the reconstructed `x-for`, `data-x-key`, the added `x-bind-href`,
    the `x-text`). Attr order captured, not guessed.
  - `map_no_xfor.tsx` — same `.map()` WITHOUT the bare `x-for` → byte-identical to today's static
    `{% for %}` (regression: no `x-for`, no `data-x-key`, no `x-bind-*`).
  - `map_xfor_bad_key.tsx` — bare `x-for` + `key={\`${t.a}-${t.b}\`}` (not a simple member) → compile
    ERROR (assert the diagnostic, not a panic).
- **Runtime** (`runtime.test.ts`):
  - marked seed nodes + an instance that EXPOSES `items` as a signal → adopt + reconcile (reuse identity)
    — covered by the existing adopt tests; add one asserting the sugar-emitted markup
    (`x-for="t in items by t.id"` + `data-x-key`) adopts.
  - marked seed nodes + an instance with NO `items` → seeds stay in the DOM untouched (static fallback):
    assert node identity unchanged AND text/attrs NOT cleared after mount.
- **Browser smoke** (if an example target is wired): the static-list page renders server-side; adding a
  behavior signal makes the SAME markup reactive.

## Acceptance criteria

1. `cargo fmt`/`clippy -D warnings`/`test` green (+ new goldens incl. the bad-key error + the
   no-`x-for` regression byte-identical); **napi rebuilt**.
2. `bun run ci` (biome) clean; `bun test runtime/` green (current baseline 470) incl. the static-fallback
   test; `typecheck:treaty` 0.
3. A bare-`x-for` `.map()` over a loader array emits the reconstructed `{% for %}` + `x-for` +
   `data-x-key` + `x-bind-*`/`x-text` (golden, captured).
4. Static fallback: a marked map with no backing signal keeps its SSR nodes (no wipe) — runtime test +
   (if wired) browser.
5. Backward compat: an unmarked `.map()` is byte-identical; the explicit `x-for="…"` path unchanged.

## Known limitations / out of scope

- **`x-bind-style` / reactive style objects — DEFERRED** to a follow-up. v1 style objects are SSR-static.
- Items not present in the SSR seed (created from the template clone for a NEW key) get the first seed's
  static style + any non-`x-text` inner content. Filter/sort of a fixed initial set (the real use case)
  never hits this.
- Single key only (`key={t.<path>}`); composite keying → explicit `x-for="… by a, b"`.
- Text reactivity only for a single map-binding expr child; mixed/element children stay SSR-static.
