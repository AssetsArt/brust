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

This runs INSIDE `lower_call_as_map` (`lower.rs:2894`), as the final step before returning the
`JsxNode::Map`, in TWO parts (a raw-AST pre-scan + a post-lowering transform) because of the key-drop
ordering (resolved Blocker 1):

**Part A — raw-AST pre-scan (BEFORE `lower_map_body_expr` at `lower.rs:2928`).** `lower_attr` silently
drops `key` (`lower.rs:2345`), so by the time the body is lowered to a `JsxNode` the `key` is GONE.
Therefore, BEFORE lowering the body, peek the raw arrow `body_expr: &SwcExpr`:
- Strip parens; the body must resolve to a single `JSXElement` (the map's per-item element). If it does
  NOT (e.g. a `JsxNode::Cond` per-item conditional, a fragment, or text) AND a bare `x-for` is present on
  it, that's unsupported in v1 → **compile error** (see limitations). If no bare `x-for`, no-op (normal
  static map).
- Scan the element's `opening.attrs` for a bare `x-for` (a `JSXAttr` named `x-for` with `value: None`).
  If absent → no sugar (return the plain Map).
- If the bare `x-for` IS present, REQUIRE a `key={…}` attr whose expression is a single map-binding
  member path rooted at the arrow binding (`key={t.id}` → path `t.id`, root must == `binding`). Extract
  the key path string. A `key` that is absent, a literal, a template string, a composite, or rooted at a
  non-binding ident → **`LowerError`** (`ErrorKind::MapXForKeyRequired` or similar) directing the author
  to the explicit `x-for="… by …"` form. (Surface the authoring mistake; never silently drop.)
- Also require the Map `source` to resolve to a real template-scope array path (`Field`/`MemberAccess`
  via the existing `resolve_xfor_source`); else → compile error (a bare `x-for` over a non-array source
  is meaningless). This is stricter than the explicit path (which falls back to static) because the bare
  flag is an explicit opt-in — a non-array source is a mistake, not a fallback.

**Part B — post-lowering transform (AFTER `lower_map_body_expr`, on the lowered body `JsxNode::Element`).**
With the captured `key_path` from Part A:
- **Reconstruct the `x-for` expression**: `binding` + `emit_expr_path(source)` + `by <key_path>` →
  replace the bare `x-for` `AttrValue::Empty` attr with `x-for="t in typeTiles by t.id"` (`Static`), so
  the runtime `parseFor`/`bindFor` works unchanged.
- **`data-x-key`**: from `key_path` via `path_to_map_expr` → `set_or_push_attr(attrs, "data-x-key",
  Expr(MapMember t.id))` → emits `data-x-key="{{ (t.id) | e }}"`. (Single key only; reuses the existing
  helper.)
- **Auto-convert map-binding attrs → `x-bind-*`** (INVERSE of the explicit-path `transform_xfor_element`,
  `lower.rs:784`, which reads `x-bind-*` and adds the real attr): for each attr whose value is
  `AttrValue::Expr` rooted at the binding (`href` = `Expr(MapMember t.href)` — already emits the SSR
  value `href="{{ (t.href) | e }}"`), ADD a sibling `x-bind-<name>="t.href"` (`Static`) for the client to
  re-bind on adopt. The attr NAME is already React-renamed at lowering time (`className` → `class` via
  `rename_attr`, `lower.rs:1834`), so the sugar reads `class` and emits `x-bind-class` — it does NOT
  re-rename. Attrs whose value is `Static`/`StaticNum`/`Empty` (a literal `class="…"` not referencing
  `t`) are left untouched (they never change per item).
- **Text child** — when the element's children are a SINGLE `JsxNode::Expr` rooted at the binding
  (`{t.label}`), ADD `x-text="t.label"` (`Static`); the SSR value child stays. Mixed / multiple /
  element children → left as static SSR (not re-bound; documented limitation).
- **`style={{ … }}` object referencing `t`** — left as the SSR-static value (no `x-bind-style`).
  DEFERRED per Non-goals.

> Interaction with the explicit path: a bare `x-for` is `AttrValue::Empty`, and `try_xfor_ssr`
> (`lower.rs:712`) matches only `("x-for", AttrValue::Static(_))`, so the bare flag passes through
> `lower_element` UNtouched — no double-processing. The sugar in `lower_call_as_map` is the sole handler.
> It reuses `data-x-key` emit + `set_or_push_attr` + `path_to_map_expr` + `resolve_xfor_source`.

### 2. Runtime — static fallback guard (TS, `bindForAdopt`)

The just-merged `bindForAdopt` reads `list = read(instance, listPath)`, builds a key index, adopts the
seeds, and installs the keyed reconcile. NEW guard for the "marked map, no backing signal" case (an
author used the flag but no behavior exposes `typeTiles`, or the list is inside an unrelated `x-data`):

- Before adopting, resolve the source non-reactively: `resolveRaw(instance, listPath)`. `resolveRaw`
  returns the value WITHOUT calling it, so for a behavior exposing `items = signal(...)` it returns the
  **signal object** (truthy) — present-but-empty (`signal([])`) and present-but-undefined-value
  (`signal(undefined)`) both still resolve truthy and proceed to the normal adopt/reconcile. Only a
  TRULY ABSENT path (no `items` property/signal on the instance at all) returns `undefined`.
- If `resolveRaw(instance, listPath) == null` (truly absent) → **return early WITHOUT installing the
  reconcile and WITHOUT touching the seed nodes** — the SSR list stays exactly as rendered (fully
  static). Do NOT bind `x-text`/`x-bind-*` either (binding against a missing source would read
  `undefined` and clear the SSR content).
- Otherwise (a signal/array is registered) → unchanged: adopt + reconcile as today. NOTE: the current
  `bindForAdopt` ALWAYS calls `installKeyedReconcile`, whose `effect()` fires synchronously and, with an
  empty `arr`, `disposeEntry`s every seed (`runtime.ts` ~`:293`, `node.remove()`) — i.e. the wipe is
  active, not passive. The guard's early return is what prevents it.

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
    Attr order is captured from REAL emit (the added `x-bind-*`/`data-x-key` are appended by
    `set_or_push_attr`), never hand-guessed.
  - `map_no_xfor.tsx` — same `.map()` WITHOUT the bare `x-for` → byte-identical to today's static
    `{% for %}` (regression: no `x-for`, no `data-x-key`, no `x-bind-*`).
- **Compiler UNIT tests** (`lower.rs` `#[cfg(test)]`, the `compile_full(...).unwrap_err()` pattern at
  `lower.rs:~4164/5014` — NOT the golden harness, which `panic!`s on a compile error and cannot assert
  one): bare `x-for` + `key={\`${t.a}-${t.b}\`}` (template string, not a member) → `LowerError`; bare
  `x-for` with NO `key` → `LowerError`; bare `x-for` over a non-array source → `LowerError`. Assert the
  error kind, not a panic.
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
- **Conditional / non-element map body** — bare `x-for` is only supported when the `.map()` body strips
  to a single `JSXElement`. A per-item conditional body (`t.active && <li x-for key=…>`), a fragment, or
  a text body carrying the flag → **compile error** in the Part-A pre-scan (don't leave a dead bare
  `x-for=""` attr in the output). Conditional-per-item reactive lists stay on the explicit path / are a
  future follow-up.
- **Async/undefined-value source** — the runtime guard uses `resolveRaw != null` (signal-object
  presence), so a registered signal whose value is momentarily `undefined`/`[]` proceeds to adopt
  (reconcile shows an empty list), NOT static-fallback. Static-fallback is strictly "no signal at all".
