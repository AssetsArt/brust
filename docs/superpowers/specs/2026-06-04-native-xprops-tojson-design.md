# Native `x-props` auto-serializes structured values (`| tojson`)

> Status: design · 2026-06-04 · FRAMEWORK feature (Rust compiler `crates/jsx-rust-compiler` emit +
> `crates/brust` minijinja config + pokedex example). Needs napi rebuild. Targets 0.1.31-alpha.

## Goal

Let a native `x-data` component receive a **structured** value (array/object) directly via `x-props`,
with the framework serializing it to JSON in-template — instead of forcing the loader to pre-`JSON.stringify`
it. This removes the redundancy where a loader returns both a real array (the SSR `{% for %}` source) AND
a stringified copy of the same data (the client `x-props`), and deletes the "native templates can't
JSON.stringify" loader hack.

After: `browseLoader` returns only `items`; `<DexFilter items={items} />`; `<section x-props={items}>`
serializes the array; the behavior reads `props` (the array). One source, no separate `dexProps`.

## Non-goals

- **Eliminating the on-the-wire data duplication.** The SSR'd 151 cards (display data) and the `x-props`
  JSON (full item data, incl. the `name` filter key the cards lack) still both ship. Client-side
  filtering needs the data; reading it from the DOM instead is a separate, larger change — OUT OF SCOPE.
- **A new attribute or opt-in marker.** `x-props` itself becomes auto-serializing (see Breaking change).
- **Islands** — `data-brust-props` already serializes via the runtime manifest; unchanged.
- **A general `tojson` authoring filter** in native templates (`{x | tojson}` in arbitrary positions).
  Only the `x-props` attribute is special-cased.

## High-level design

### 1. minijinja `json` feature (`crates/brust` + compiler test harness)
The render-side minijinja (`crates/brust/src/jinja.rs`) and the compiler's golden-render test harness
(`crates/jsx-rust-compiler/tests/golden_render_jinja/`) currently use `minijinja = "2"` with the default
feature set, which does NOT include the `json` feature → `{{ x | tojson }}` errors `UnknownFilter`
(verified empirically). Enable it: `minijinja = { version = "2", features = ["json"] }` in BOTH
`crates/brust/Cargo.toml` and `crates/jsx-rust-compiler/Cargo.toml`. minijinja auto-registers the
built-in `tojson` filter when the feature is on (no `add_filter` call needed). No other env change
(`AutoEscape::None` + `UndefinedBehavior::Chainable` stay).

### 2. Compiler — `x-props` emits `| tojson | e` (`emit_jinja.rs`)
`emit_attr` (`emit_jinja.rs:377`) emits every dynamic attr as `name="{{ (expr) | e }}"` via
`emit_escaped_interp`. Special-case the attribute named `x-props` carrying an `AttrValue::Expr`: emit
`x-props="{{ (expr) | tojson | e }}"` instead. The `| tojson` serializes the structured value to a JSON
string; the existing `| e` then HTML-escapes it (so `"` → `&quot;` etc.) — safe inside the
double-quoted attribute, and the browser un-escapes it back to parseable JSON on read (same XSS-safe
model as today, mirrors the islands `entityEncode(JSON.stringify(...))` path). A `Static`/`Empty`
`x-props` (a literal string, not `{expr}`) is left UNCHANGED (no tojson) — only the `{expr}` form
serializes. The `x-props` value expr is a member-path (`Field`/`MemberAccess`) as today — `lower_attr`
accepts it unchanged; only the EMIT changes.

> No `lower.rs`/IR change. The compiler still lowers `x-props={items}` to `AttrValue::Expr(Field("items"))`;
> the per-attr emit is the only delta. `emit_expr_path` already renders the member path inside `(…)`.

### 3. Example migration (pokedex) — pass structured values, drop the stringify hack
- **DexFilter** (`components/DexFilter.tsx`): `<section x-data="dexFilter" x-props={items}>` (was
  `x-props={data}`). The default signature drops `data`: `DexFilter({ items }: { items: Card[] })`. The
  behavior reads the array directly: `const all = ((props as Card[]) ?? [])` (was `(props as {items?})?.items`).
  The grid `.map()` already iterates `items`; now `items` feeds BOTH the SSR `{% for %}` and the
  serialized `x-props`.
- **browseLoader** (`lib/loaders.ts`): return only `items` (drop `dexProps`).
- **BrowsePage** (`pages/BrowsePage.tsx`): `<DexFilter native items={items} />` (drop `data={dexProps}`).
- **BrowseData** (`lib/types.ts`): drop `dexProps: string` (keep `items: DexCard[]`).
- **AddToTeamButton** (`components/AddToTeamButton.tsx`): `x-props={addProps}` where `addProps` is now the
  OBJECT (not a string). The behavior reads `props.id`/`props.name`/… UNCHANGED (props is the object).
- **detailLoader / emptyDetail** (`lib/loaders.ts`, 2 sites): `addProps: { id, name, … }` (drop the
  `JSON.stringify(...)` wrapper + the "can't JSON.stringify" comment).
- **DetailData** (`lib/types.ts`): `addProps` type `string` → the object shape.
- **NavLink** — does NOT use `x-props` (reads href off the element); UNCHANGED.

## Breaking change (call out)

`x-props` now ALWAYS `| tojson`-serializes its `{expr}` value. Any existing usage that passed a
**pre-stringified JSON string** to `x-props` double-encodes (the string gets JSON-quoted) and breaks. In
this repo the only two such usages are DexFilter + AddToTeamButton, both migrated here. External alpha
users passing a string must switch to passing the structured value. Documented; acceptable on the alpha
line.

## Tests

- **Compiler golden** (`golden_emit_jinja` + `golden_render_jinja`): a native element
  `<section x-data="c" x-props={items}>…` whose `items` is a structured prop → emits
  `x-props="{{ (items) | tojson | e }}"` (emit golden); rendering with a context `items = [{...}]` →
  the attribute contains the HTML-escaped JSON of the array (render golden — proves `tojson` is wired +
  the json feature is on). A second fixture confirms a NON-`x-props` attr (e.g. `href={x}`) STILL emits
  plain `| e` (no tojson) — regression that the special-case is scoped to `x-props`.
- **Runtime / behavior**: no runtime-code change; the directive runtime already `JSON.parse`s `x-props`.
  Confirmed by the integration/browser smoke (AddToTeamButton + DexFilter both parse + work).
- **Integration / browser smoke**: build pokedex; `curl /pokedex` → the `<section x-data="dexFilter"
  x-props="…">` contains the escaped JSON array (not `[object Object]`), and the 151 cards still SSR;
  after hydrate, search filters (DexFilter behavior parsed the array). Detail page: AddToTeam button
  reflects membership (AddToTeamButton behavior parsed the object). Captured, not prose.

## Acceptance criteria

1. `cargo fmt`/`clippy -D warnings`/`test` green (+ new x-props goldens incl. the non-x-props regression
   + the render golden proving tojson); **napi rebuilt**.
2. `bun run ci` (biome) clean; `bun test runtime/` green (baseline 472); `typecheck:treaty` 0.
3. native integration suite green.
4. `curl /pokedex` server HTML: `x-props` on the dex section is the HTML-escaped JSON **array** of items
   (captured); 151 cards still present. `browseLoader` returns NO `dexProps`; no `JSON.stringify` remains
   in `lib/loaders.ts`.
5. Browser: `/pokedex` search filters (DexFilter parsed the serialized array); a detail page's AddToTeam
   button toggles (AddToTeamButton parsed the serialized object).
6. Backward compat WITHIN the new contract: a non-`x-props` attribute still emits plain `| e` (golden).

## Known limitations / out of scope

- On-the-wire data still duplicated (SSR cards + x-props JSON) — see Non-goals.
- Only the `x-props` attribute auto-serializes; no general in-template `tojson` for authors.
- Breaking for pre-stringified `x-props` callers (migrated internally; documented for alpha).

## Open questions resolved at plan-time

- **Escaping**: `| tojson | e` (JSON then HTML-escape) — verified safe for a double-quoted attribute;
  matches the existing `| e` XSS model and the islands `entityEncode(JSON.stringify())` precedent.
- **Scope of special-case**: by attribute NAME `x-props`, Expr-valued only; Static x-props untouched.
- **Feature flag location**: both `crates/brust` (render) and `crates/jsx-rust-compiler` (golden-render
  test harness) need `features = ["json"]`.
