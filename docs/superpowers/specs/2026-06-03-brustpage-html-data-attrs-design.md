# `<BrustPage>` arbitrary `data-*` on `<html>`

**Date:** 2026-06-03 · **Status:** design (auto-pipeline) · **Repo:** brust
**FRAMEWORK-GAP:** "`<BrustPage>` ยังตั้ง `data-*` บน `<html>` ตามใจไม่ได้"
(`example/pokedex/FRAMEWORK-GAPS.md`; dark-mode entry — design wanted
`[data-mode="dark"]` toggling but the shell only emits `lang`/`class`).

## Goal

Let a `native: true` route author set arbitrary `data-*` attributes on the
`<html>` element via `<BrustPage data-foo="bar" data-mode={d.theme}>`. Values
accept a string literal or a loader member-path (HTML-escaped), exactly like the
existing `lang`/`className`/`title` props (S8). This unblocks
`[data-mode]`-style theming hooks on the document root.

## Finding (reproduced)

`data-*` props are currently **silently dropped**. `lower_brust_page`
(lower.rs:772-779) matches only `lang`/`className`/`bodyClassName`/`title`/
`description`/`head` and `_ => continue`s everything else. Compiling
`<BrustPage title="x" data-mode="dark" data-theme={theme}>…` emits
`<html lang="en">…` — no `data-*`. SWC parses `data-mode` as a plain
`JSXAttrName::Ident` (no error), so it just falls into the ignore arm.

## Non-goals

- **Not** the full PokéDex dark-mode TOGGLE. A working toggle needs a cookie
  round-trip + a toggle control (native directive or island) to mutate
  `data-mode` — a composite feature. This spec ships only the shell capability
  (`<html>` can carry loader/literal `data-*`); the toggle is deferred and noted
  in FRAMEWORK-GAPS.
- Only `data-*`. `aria-*` is a trivial future extension (same mechanism) but out
  of scope here to keep the surface minimal.
- No `data-*` on `<body>` or other elements — `<html>` only (the gap).

## Architecture

A new ordered list of `(name, HeadValue)` html attributes on the `Document` IR,
populated in lowering, emitted on `<html>` after `class`. Reuses the existing
`HeadValue` (literal/path) + `emit_head_attr` (escape) machinery — no new
escaping path.

### 1. IR (`crates/jsx-rust-compiler/src/ir.rs`)

Add a field to the `Document` variant:
```rust
/// `<html data-*>` — arbitrary data attributes, source order. Each value is a
/// literal or a loader member-path (escaped like lang/class).
html_attrs: Vec<(String, HeadValue)>,
```

### 2. Lowering (`crates/jsx-rust-compiler/src/lower.rs`, `lower_brust_page`)

- Declare `let mut html_attrs: Vec<(String, crate::ir::HeadValue)> = Vec::new();`
- In the attr loop, BEFORE the curated `match name.as_str()`, intercept names
  starting with `data-`:
  - Validate the name matches `^data-[a-z0-9-]+$` (lowercase HTML data-attr
    charset). A non-conforming `data-*` name → reject with a new
    `ErrorKind::InvalidDataAttrName(String)` (loud, not silent — the author
    clearly intended a data attr).
  - Parse the value with the SAME literal/member-path logic the scalar slots use
    (string literal → `HeadValue::Literal`; member-path expr → `HeadValue::Path`;
    anything else → `BrustPageAttrMustBeStringLiteral(name)`). Factor the
    value-parsing into a small helper to avoid duplicating the match, OR inline
    it mirroring the existing block.
  - `html_attrs.push((name, value)); continue;`
- Pass `html_attrs` into the `JsxNode::Document { … }` constructor.

Non-`data-` unknown attrs keep the existing `_ => continue` (ignored, forward-compat).

### 3. Emit (`crates/jsx-rust-compiler/src/emit_jinja.rs`, `Document` arm)

After the `html_class` block (line ~99), before `out.push_str("><head>")`:
```rust
for (name, hv) in html_attrs {
    emit_head_attr(out, name, hv);
}
```
Destructure `html_attrs` in the `JsxNode::Document { … }` pattern.

Emitted output:
- `data-mode="dark"` → ` data-mode="dark"` (attr-escaped literal)
- `data-mode={d.theme}` → ` data-mode="{{ (d.theme) | e }}"` (escaped interp —
  `AutoEscape::None`, so `| e` is load-bearing; matches lang/class/title).

### 4. TS types (`runtime/islands/brust-page.tsx`)

- `BrustPageProps`: add an index signature for data attributes:
  ```ts
  /** Arbitrary `data-*` on `<html>` (e.g. `data-mode="dark"`). Literal or
   *  loader member-path on the native path. */
  [dataAttr: `data-${string}`]: string | undefined
  ```
  (Template-literal key index signatures are valid TS; existing named optional
  props coexist. Verify biome/tsc accept it — if the index signature conflicts
  with `children?: ReactNode`, scope the signature to `string` only and keep
  `children` as-is; ReactNode is not `string`, so a `data-${string}` key
  signature does NOT cover `children`.)
- React mirror `BrustPage(...)`: capture `...rest` in the destructure and spread
  the `data-*` keys onto the `<html>` `createElement` props so the rare
  non-native React render matches the compiled output:
  ```ts
  export function BrustPage({ lang = 'en', className, bodyClassName, title,
    description, head, children, ...rest }: BrustPageProps): ReactNode {
    const dataAttrs = Object.fromEntries(
      Object.entries(rest).filter(([k]) => k.startsWith('data-')),
    )
    return createElement('html', { lang, className, ...dataAttrs }, /* …head…, body… */)
  }
  ```

## Tests

**Compiler golden** (`crates/jsx-rust-compiler/src/lib.rs`), `assert_eq!` byte-exact:
1. `brustpage_html_data_attr_literal` — `<BrustPage data-mode="dark">…` →
   `<html lang="en" data-mode="dark">…`.
2. `brustpage_html_data_attr_dynamic` — `data-theme={d.mode}` →
   `<html lang="en" data-theme="{{ (d.mode) | e }}">…`.
3. `brustpage_html_data_attrs_multiple_order` — two `data-*` keep source order.
4. `brustpage_html_data_attr_with_class` — `className` + `data-*` →
   `<html lang="en" class="…" data-mode="…">` (class before data-*).
5. `brustpage_html_data_attr_call_rejected` — `data-x={fn()}` →
   `BrustPageAttrMustBeStringLiteral`.
6. `brustpage_invalid_data_attr_name_rejected` — `data-Foo` / `data-` →
   `InvalidDataAttrName`.

**Lower unit** (lower.rs tests): the new `InvalidDataAttrName` error fires on a
malformed name.

**Runtime render** (`tests/jinja-route.test.ts` + a fixture): a `native: true`
page using `<BrustPage data-mode="dark" data-rev={rev}>` renders
`<html … data-mode="dark" data-rev="<loader-value>">` through the real pipeline.
(Reuse the port-3801 fixture-app boot; add a small native page + route, OR — if a
BrustPage-using native fixture already exists — extend it.)

## Acceptance criteria

1. `<BrustPage data-* …>` emits the attrs on `<html>` (literal + member-path,
   escaped); class precedes data-*; source order preserved.
2. Malformed `data-*` name → `InvalidDataAttrName`; non-path/literal value →
   `BrustPageAttrMustBeStringLiteral`.
3. `BrustPageProps` accepts `data-*` keys (biome green; React mirror spreads them).
4. Runtime render test proves end-to-end.
5. All CI gates green (biome, fmt, clippy, cargo test, full bun test).
6. After the Rust change, the napi addon is rebuilt (`cd runtime && bun run
   build:debug`) before bun tests that boot the server.
7. FRAMEWORK-GAPS dark-mode entry updated: `data-*` shell support ✅; full
   toggle still deferred.

## Known limitations / deferred

- Full pokedex dark-mode toggle (cookie + toggle control) — deferred (composite).
- `aria-*` and other passthrough html attrs — not handled (data-* only).
- `data-*` on `<body>`/other elements — not handled.

## Verification gotchas

- This IS a Rust compiler change → MUST rebuild the napi addon
  (`cd runtime && bun run build:debug`) before any bun test booting the server,
  else stale `.node`.
- TS gate is biome (`bun run ci`), not tsc.
- Add the new `ErrorKind::InvalidDataAttrName` to whatever exhaustive match /
  Display impl `ErrorKind` requires (clippy `-D warnings` will catch a missing arm).
