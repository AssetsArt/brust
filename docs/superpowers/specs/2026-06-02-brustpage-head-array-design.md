# Spec — `<BrustPage head={[…]}>` typed head-entry array

**Date:** 2026-06-02 · **Branch:** `feat/brustpage-head-array` · **Status:** design

## Goal

Let a native `<BrustPage>` declare arbitrary `<head>` elements via a typed array
prop (NOT framework auto-injection). Each entry is a plain object discriminated
by `tag`; a TypeScript discriminated union constrains the allowed fields per tag.

```tsx
<BrustPage title="…" head={[
  { tag: 'link',   rel: 'icon', href: '/favicon.svg' },
  { tag: 'meta',   property: 'og:title', content: data.title },  // member-path OK
  { tag: 'script', src: '/analytics.js', defer: true },
  { tag: 'style',  text: '.x{color:red}' },
]}>
```

Allowlist: `link, meta, base, style, script, noscript`. Existing props
(title/description/lang/className/bodyClassName) stay unchanged (backward-compat).

## Non-goals

- NOT auto-injected. No default favicon. Entries appear only when authored.
- No arbitrary tags outside the allowlist.
- Native path: attribute values are string-literal or loader member-path only
  (same contract as existing BrustPage props). No calls/arithmetic.
- `text` (inner content of style/script/noscript) is **static string literal
  ONLY** — dynamic text is rejected (XSS: dynamic JS/CSS is an injection vector).
- No per-entry `key`, no nested children beyond the single `text` string.

## Security model (load-bearing)

brust runs minijinja `AutoEscape::None`; all dynamic output is escaped via `| e`.
- **attribute values:** literal → attribute-escaped at build; member-path →
  `{{ (path) | e }}` (runtime HTML-escape). Same as title/description. Safe.
- **`text` content:** emitted **RAW** (un-escaped) — escaping would corrupt JS/CSS.
  Safe ONLY because `text` is forced to a compile-time string literal in `lower`
  (a member-path in `text` is a hard compile error). Developer-authored static
  text is trusted (it's their own source), exactly like writing a `<script>` tag.

## IR (`crates/jsx-rust-compiler/src/ir.rs`)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadTag { Link, Meta, Base, Style, Script, Noscript }

impl HeadTag {
    pub fn name(self) -> &'static str { /* "link".."noscript" */ }
    /// void = self-closing, no text content.
    pub fn is_void(self) -> bool { matches!(self, HeadTag::Link | HeadTag::Meta | HeadTag::Base) }
}

#[derive(Debug, Clone)]
pub struct HeadEntry {
    pub tag: HeadTag,
    /// attr name (already camelCase→html mapped) → literal|member-path value.
    pub attrs: Vec<(String, HeadValue)>,
    /// presence attrs from boolean `true` (e.g. `defer`, `async`).
    pub bool_attrs: Vec<String>,
    /// inner content for style/script/noscript — static literal only.
    pub text: Option<String>,
}
```
Add `head: Vec<HeadEntry>` to `JsxNode::Document`.

## Lowering (`lower.rs`, in `lower_brust_page`)

Special-case the `head` prop BEFORE the existing HeadValue slot match (it's an
array, not a HeadValue). Mirror the SWC object-parse pattern already in this file
(the `lower_isr_config`-style block ~line 1683: `PropOrSpread::Prop` →
`Prop::KeyValue` → `PropName::Ident|Str` → `Lit::Str`/`Lit::Bool`/`SwcExpr::Array`).

- value must be `JSXExprContainer` → `JSXExpr::Expr` → `SwcExpr::Array`
  (else `BrustPageHeadMustBeArray`).
- each elem: no hole/spread; `SwcExpr::Object` (else `BrustPageHeadEntryInvalid`).
- per object, read props:
  - `tag`: `Lit::Str` ∈ allowlist → `HeadTag` (missing/invalid → `BrustPageHeadEntryInvalid`).
  - `text`: `Lit::Str` only → `HeadEntry.text`. Member-path/expr → `BrustPageHeadTextMustBeLiteral`.
    On a void tag → `BrustPageHeadTextOnVoid`.
  - any other key:
    - `Lit::Bool(true)` → `bool_attrs.push(map_key(k))`; `Bool(false)` → skip.
    - `Lit::Str` → `attrs.push((map_key(k), HeadValue::Literal(s)))`.
    - member-path (via the existing `lower_expr` → `Field`/`MemberAccess` branch
      used for title/description) → `attrs.push((map_key(k), HeadValue::Path(e)))`.
    - anything else → `BrustPageAttrMustBeStringLiteral(k)` (reuse).
  - `map_key`: `crossOrigin`→`crossorigin`, `httpEquiv`→`http-equiv`, else the key
    as-is (the union's other fields are already lowercase html attr names).
- Unknown-but-well-typed keys are emitted as attrs (lenient — the TS union is the
  authoring gate); a key the union forbids never reaches here in typed code.
- Thread `head: Vec<HeadEntry>` into the returned `JsxNode::Document`.

New `ErrorKind`s (in `lib.rs`, with messages):
- `BrustPageHeadMustBeArray` — "`head` must be an array literal of head-entry objects"
- `BrustPageHeadEntryInvalid` — "each `head` entry needs a `tag` of link|meta|base|style|script|noscript"
- `BrustPageHeadTextMustBeLiteral` — "`head` entry `text` must be a string literal (no dynamic values — XSS)"
- `BrustPageHeadTextOnVoid` — "`text` is not allowed on a void head tag (link/meta/base)"

## Emit (`emit_jinja.rs`, in the `JsxNode::Document` arm)

After the `app.css` stylesheet link, before `</head>`, for each `HeadEntry`:
```rust
out.push('<'); out.push_str(entry.tag.name());
for (name, hv) in &entry.attrs { emit_head_attr(out, name, hv); }   // reuse existing helper
for b in &entry.bool_attrs { out.push(' '); out.push_str(b); }
if entry.tag.is_void() {
    out.push_str("/>");
} else {
    out.push('>');
    if let Some(t) = &entry.text { out.push_str(t); }   // RAW (static literal)
    out.push_str("</"); out.push_str(entry.tag.name()); out.push_str(">");
}
```
`emit_head_attr` already does literal→attr-escaped / path→`{{ (p) | e }}`.

## TS (`runtime/islands/brust-page.tsx`)

```ts
export type HeadEntry =
  | { tag: 'link';   rel: string; href: string; type?: string; sizes?: string; as?: string; media?: string; crossOrigin?: string }
  | { tag: 'meta';   name?: string; property?: string; httpEquiv?: string; content: string }
  | { tag: 'base';   href?: string; target?: string }
  | { tag: 'style';  text: string; media?: string }
  | { tag: 'script'; src?: string; text?: string; type?: string; defer?: boolean; async?: boolean; crossOrigin?: string }
  | { tag: 'noscript'; text: string }
```
Add `head?: HeadEntry[]` to `BrustPageProps`. React mirror (non-native path): map
each entry to `createElement(tag, attrsWithoutTagText, text ?? undefined)`. For
`style`/`script`/`noscript`, pass `text` as children. Booleans pass through;
`crossOrigin`/`httpEquiv` are valid React DOM props. (Mirror is best-effort — the
native compiled output is authoritative.)

## Apps

- `runtime/cli/templates/minimal/pages/Home.tsx.tmpl`: add
  `head={[{ tag: 'link', rel: 'icon', href: '/favicon.svg' }]}` to `<BrustPage>`.
- `example/pokedex/components/PageLayout.tsx`: same on its `<BrustPage>`.

## Tests

**Rust (`emit_jinja.rs` / `lower.rs` `#[cfg(test)]`)**
- emit: Document with head `[link rel=icon href=/favicon.svg]` → contains
  `<link rel="icon" href="/favicon.svg"/>`; `script src=/x.js defer:true` →
  `<script src="/x.js" defer></script>`; `style text=".x{}"` → `<style>.x{}</style>`;
  `meta property=og:title content={path}` → `content="{{ (path) | e }}"`.
- lower: member-path `text` → `BrustPageHeadTextMustBeLiteral`; `text` on `link`
  → `BrustPageHeadTextOnVoid`; non-object entry → `BrustPageHeadEntryInvalid`;
  non-array `head` → `BrustPageHeadMustBeArray`; `crossOrigin`→`crossorigin` mapping.

**Integration / scaffold**
- rebuild `.node`; `native-island-ssr` + `cli-new` stay green.
- pokedex build → view-source `/` contains `<link rel="icon" href="/favicon.svg"/>`
  in `<head>` (manual smoke).

## Acceptance criteria

1. `cargo fmt/clippy(-D warnings)/test` green (new Rust tests).
2. `bun run ci` clean; rebuild `.node`; `native-island-ssr` + `cli-new` + `integration` green.
3. Manual smoke: pokedex `/` head has the favicon link; `curl /favicon.svg` 200 (already shipped).
4. minimal scaffold emits a `<BrustPage head={[…favicon…]}>`.

## Known limitations

- `text` is static-literal only (dynamic JS/CSS unsupported by design — XSS).
- No `key`/ordering control beyond array order; entries emit after the css link.
- React mirror is best-effort for the non-native path.
