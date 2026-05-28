# Spec — JSX→Rust compiler (Phase A1 MVP) — SWC + maud

**Date:** 2026-05-28
**Branch:** `refactor/cargo-workspace`
**Parent commit:** `1b90651` (spec v1, hand-rolled + string-builder; revised after user direction)
**Status:** design, not implemented
**Skill chain:** Path A → Phase A1 (per handoff `/tmp/brust-handoff-2026-05-28-workspace-refactor-and-path-A-spikes.md`)

---

## 0. Why v2

Spec v1 chose hand-rolled lexer/parser + string-builder Rust emit, with byte-equivalence to React's `renderToStaticMarkup` as the success bar. User direction: **stay on Path A as originally planned** — `swc_core` 68 + `maud` 0.27. This v2 supersedes v1 and pins the original-plan stack:

- **Parser**: `swc_core` 68.0.1 (latest stable, exposes `swc_ecma_parser` for `.tsx`).
- **Emit**: Rust source containing a `maud::html! { … }` block.
- **Runtime**: just the `maud` crate at the consumer side; no separate `jsx-rust-runtime` crate.

Byte-equivalence with React's `renderToStaticMarkup` is **dropped** — maud and React produce different HTML5 dialects (void elements `<br>` vs `<br/>`, attribute escape set 4 vs 5 chars, etc.). The new success bar is **golden emit + golden render via maud**: the compiled fixture's `render()` output is captured once and committed; the test confirms determinism, not React parity.

Where v2 differs from v1 substantively, sections are flagged `(v2 change)`.

## 1. Goal

Land a working **JSX→Rust compiler** as a new workspace crate `crates/jsx-rust-compiler/`. The compiler accepts a constrained subset of TypeScript JSX and emits Rust source containing a `maud::html!` block that, when compiled, renders the equivalent HTML.

Phase A1 ships scaffolding + parser wiring + AST lowering + emit + tests for a tiny dialect. Loader integration (A2), islands bridge (A3), conditionals/fragments/custom components (A4) are explicit non-goals.

Phase A1 makes **no perf claim**. Spike B already proved 104k RPS is reachable with hand-written maud templates; A1 proves it's reachable from machine-generated maud templates for trivial dialects. A2's harness integration is where perf is measured.

## 2. Non-goals (explicit deferrals)

| Feature | Why deferred | Phase |
|---|---|---|
| Custom JSX components (`<Layout/>`, `<Counter/>`) | Needs component resolution / cross-file linking | A4 |
| Conditional rendering (`{cond ? <A/> : <B/>}`) | Needs control-flow lowering | A4 |
| Fragments (`<>…</>`) | Trivial but unused in fixtures; defer | A4 |
| Template literals (`` `${x}` ``) | Mini-expression-evaluator beyond ident+member | A4 |
| Nullish coalescing / arithmetic / function calls in `{expr}` | Same — expression-evaluator | A4 |
| TypeScript type-checking | We trust the upstream `tsc` in `bun run build`; we type-erase | never |
| Loader/`data` prop wiring | Napi bridge needed | A2 |
| Islands marker emission | Island registry + client-bundle handshake | A3 |
| Hot reload / dev-mode JS fallback | Runtime selector | A5+ |
| Source maps / pretty error messages | swc gives us spans for free — pretty rendering is A5+ | A5+ |
| `async function` components, `Suspense`, hooks | React semantics; out of scope for static maud | never |
| HelloWorld.tsx end-to-end | Depends on custom components + template literals | A4 |
| Byte-equivalence with React `renderToStaticMarkup` | maud and React are different HTML5 dialects; equivalence is semantic only | never |

## 3. High-level architecture

```
crates/jsx-rust-compiler/
├── Cargo.toml             # workspace member, package = "jsx-rust-compiler"
├── src/
│   ├── lib.rs             # pub use compile, CompileError
│   ├── parser.rs          # swc_core entrypoint: source → swc_ecma_ast::Module
│   ├── lower.rs           # swc AST → our small CompiledComponent IR (props + JSX tree)
│   ├── ir.rs              # CompiledComponent, JsxNode, Expr, AttrValue — IR types
│   ├── emit.rs            # IR → Rust source string (struct Props + fn render() -> Markup)
│   └── bin/
│       └── jsx-rustc.rs   # CLI: read .tsx → stdout, or -o <file>
├── fixtures/              # input .tsx + golden emitted .rs + golden rendered .html
│   ├── static_hello.tsx
│   ├── static_hello.expected.rs
│   ├── static_hello.expected.html
│   ├── props_hello.tsx
│   ├── props_hello.expected.rs
│   ├── props_hello.expected.html
│   ├── list_nav.tsx
│   ├── list_nav.expected.rs
│   └── list_nav.expected.html
└── tests/
    ├── golden_emit.rs     # for each fixture: assert compile(input) == expected.rs
    └── golden_render/     # each fixture is a #[path = "..."] mod + a #[test] fn
        ├── mod.rs
        ├── static_hello.rs   # includes ../../fixtures/static_hello.expected.rs via #[path]
        ├── props_hello.rs
        └── list_nav.rs
```

**Workspace integration** (v2 change): only ONE new workspace member, `crates/jsx-rust-compiler`. No nested `jsx-rust-runtime` sub-package — `maud` IS the runtime. The brust cdylib in `crates/brust/` does NOT take a dependency on `jsx-rust-compiler` in A1; that wiring is A2.

**`Cargo.toml` change** (v2 change):
```toml
members = [
    "crates/brust",
    "crates/jsx-rust-compiler",
]
```

## 4. Parser strategy — swc_core 68

(v2 change — whole section rewritten.)

### 4.1 Dep table

```toml
# crates/jsx-rust-compiler/Cargo.toml
[dependencies]
swc_core   = { version = "68", features = ["ecma_ast", "ecma_parser", "ecma_visit", "common"] }
thiserror  = "1"
```

`swc_core` 68 (released as of crates.io max_stable 2026-05) bundles internally-consistent versions of `swc_common`, `swc_ecma_ast`, `swc_ecma_parser`, `swc_ecma_visit`. The serde compat issue that burned the prior session (`serde::__private` removed in serde 1.0.220+, used by `swc_common` 6.x via `swc_core` 13) is the explicit reason the swc team rolled the bundle — verify in T1 by running `cargo build -p jsx-rust-compiler` with the workspace's existing `serde = "1"`. If T1 fails to build, see §15.1 BLOCKED fallback.

### 4.2 Parser invocation

Use `swc_ecma_parser::lexer::Lexer` + `Parser` configured for `TsConfig { tsx: true, .. Default::default() }`. Input: `&str`. Output: `swc_ecma_ast::Module`. Errors: collect via `Vec<swc_ecma_parser::error::Error>`, surface the first as a `CompileError::Parse { span, message }` carrying the byte range.

### 4.3 What we accept from the swc AST

A `Module` whose only statement at top level is a single `ExportDefaultDecl { decl: FnExpr { … } }` — equivalent to `export default function Name(props) { return <JSX>; }`. Imports are silently accepted but unused (v2 change — v1 errored on imports; v2 is lenient since real files have type imports). Other top-level statements → `CompileError::UnexpectedStatement { span }`.

The function body must be a single `ReturnStmt` returning a single `JSXElement` (optionally wrapped in `ParenExpr`). Multiple statements / locals / `if`s in the body → `CompileError::BodyMustBeSingleReturn { span }`.

The function param must be either:
- empty `()`
- `({ a, b, c }: Type?)` — `ObjectPat` with `BindingIdent` patterns (no rest, no nested destructuring, no defaults beyond literal)
- `(name: Type?)` — single `Ident` param, treated as `props` binding

Any other parameter shape → `CompileError::UnsupportedParam { span }`.

### 4.4 Lowering rules

The lowering pass (`src/lower.rs`) walks the swc AST and produces our small IR. Lowering is where dialect restrictions are enforced (not the parser). Each restriction maps to a specific `CompileError::Kind` for testable error messages.

`JSXElement.opening.name`:
- `JSXElementName::Ident(name)`: lowercase first letter → HTML element; uppercase first letter → `CustomComponentNotSupported { span, name }`.
- `JSXElementName::JSXMemberExpr(_)`: `MemberComponentNotSupported { span }`.
- `JSXElementName::JSXNamespacedName(_)`: `NamespacedElementNotSupported { span }`.

`JSXFragment`: `FragmentNotSupported { span }`.

`JSXAttr.name`:
- `JSXAttrName::Ident(name)`: passed through; the emitter handles renames (§4.5).
- `JSXAttrName::JSXNamespacedName(_)`: `NamespacedAttrNotSupported { span }`.

`JSXAttrName::Ident` starting with `on` + uppercase next char (e.g. `onClick`, `onSubmit`): `EventHandlerNotSupported { span, name }`. Detected BEFORE rename-table lookup. (Reviewer-flagged precedence; v2 makes it explicit.)

`JSXAttrName::Ident == "key"`: silently dropped — React-internal hint, no HTML meaning.

`JSXAttrName::Ident == "ref"`: `RefAttributeNotSupported { span }`.

`JSXAttr.value`:
- `None`: bare attribute. Lowered to `AttrValue::EmptyString` and emitted as `name=""` per HTML5 + React parity.
- `Some(JSXAttrValue::Lit(Lit::Str(s)))`: static string → `AttrValue::Static(s)`.
- `Some(JSXAttrValue::Lit(Lit::Num(n)))`: number literal → `AttrValue::StaticNum(n)`.
- `Some(JSXAttrValue::JSXExprContainer(JSXExpr::Expr(box expr)))`: see EXPR rules below.
- `Some(JSXAttrValue::JSXFragment | JSXElement)`: `JsxInAttrNotSupported { span }`.
- `Some(JSXAttrValue::JSXExprContainer(JSXExpr::JSXEmptyExpr(_)))`: parse-time invalid; swc would have errored.

`JSXAttrSpread` (e.g. `{...props}`): `SpreadAttributeNotSupported { span }`.

Element children: lowered in order, each child is one of:
- `JSXText`: whitespace-normalize per §4.6, then `JsxNode::Text(s)`.
- `JSXExprContainer(JSXExpr::Expr(expr))`: see EXPR rules below.
- `JSXExprContainer(JSXExpr::JSXEmptyExpr(_))`: silently dropped (covers `{/* comment */}`).
- `JSXElement`: recurse.
- `JSXFragment`: `FragmentNotSupported`.
- `JSXSpreadChild`: `SpreadChildNotSupported`.

`EXPR` rules (both child position and attribute-value position):
- `Expr::Ident(name)`:
  - if name == single-binding-param-name (when component was declared as `(props)`) → `PropMember(vec![])` — but bare props ident in JSX means `{props}` → invalid; `BareIdentNotSupported { span, name }`.
  - if name is in destructured-prop list → `Field(name)` (treated like `props.name`).
  - if name is the `.map` iter-binding currently in scope → `MapBinding(name)`.
  - else → `UnresolvedIdent { span, name }`.
- `Expr::Member(MemberExpr { obj: Ident(root), prop: Ident(field), .. })` and nested chains: lower as `Field(name)` (if root is destructured-prop or iter-binding) followed by member chain → `MemberAccess { root, path }`. Computed access (`obj[idx]`) → `ComputedAccessNotSupported`.
- `Expr::Lit(Lit::Str(s))` → `StaticText(s)`.
- `Expr::Lit(Lit::Num(n))` → `StaticNum(n)`.
- `Expr::Call(CallExpr { callee: MemberExpr { obj, prop: Ident("map") }, args: [arrow], .. })` where `arrow: ArrowExpr { params: [single ident], body: JSXElement }`: lower to `JsxNode::Map { source, binding, body }`. The arrow MUST be a single-param ident-binding arrow with a JSXElement body. Any other shape → `MapShapeNotSupported { span }`. (Reviewer-flagged two-param form: explicit error `MapIndexParamNotSupported`.)
- Any other call → `CallExpressionNotSupported`.
- `Expr::Tpl(_)` → `TemplateLiteralNotSupported`.
- `Expr::Bin(_) | Expr::Cond(_) | Expr::Unary(_)` → `ComplexExpressionNotSupported`.

### 4.5 Attribute renames

The emitter applies these table renames so emitted HTML matches what users expect from React:

| JSX | HTML |
|---|---|
| `className` | `class` |
| `htmlFor` | `for` |
| `charSet` | `charset` |
| `tabIndex` | `tabindex` |
| `crossOrigin` | `crossorigin` |
| `readOnly` | `readonly` |
| `maxLength` | `maxlength` |
| `colSpan` | `colspan` |
| `rowSpan` | `rowspan` |
| `srcSet` | `srcset` |

Processing order in the emitter (v2 makes precedence explicit):
1. If name matches `on[A-Z].*` → `EventHandlerNotSupported`.
2. If name == `ref` → `RefAttributeNotSupported`.
3. If name == `key` → drop.
4. If name is in rename table → emit renamed.
5. If name has uppercase letter → `UnknownAttributeRename { name }`.
6. Else → emit verbatim.

### 4.6 JSX whitespace normalization

(v2 — reviewer-flagged absent rule.) Match React's `traverseAllChildrenImpl` behavior:

- A `JSXText` node consisting ONLY of whitespace (including newlines) between two non-text children is **dropped**.
- A `JSXText` node with non-whitespace content: collapse runs of whitespace (spaces, tabs, newlines) to a single space; trim leading/trailing whitespace ONLY when the text borders a non-text sibling or the parent element boundary.
- A leading/trailing whitespace-only span at the start/end of an element's children list is dropped.

Three failing inputs would break: (a) preformatted `<pre>` content — React preserves it via the element semantics, but the JSX text itself is still collapsed at the JSX level. A1 inherits this React quirk. (b) Multiline string in `{"foo\nbar"}` — preserved verbatim, this is an EXPR not JSX text. (c) `&nbsp;` HTML entity — A1 treats `&` in JSX text as raw, NOT as an entity reference (React decodes `&nbsp;` to U+00A0; we don't). Listed as a known limitation §12.

## 5. Emit target — maud

(v2 change — whole section rewritten.)

Each compiled fixture produces a Rust file of this shape:

```rust
// === GENERATED by jsx-rust-compiler; do not edit. ===
use maud::{html, Markup, Render, PreEscaped};

pub struct Props {
    pub title: String,
    pub items: Vec<ItemsItem>,
}

pub struct ItemsItem {
    pub href: String,
    pub label: String,
}

pub fn render(props: &Props) -> Markup {
    html! {
        nav {
            ul {
                @for item in &props.items {
                    li { a href=(item.href) { (item.label) } }
                }
            }
        }
    }
}
```

### 5.1 Emit rules — JSX → maud

| IR node | maud emission |
|---|---|
| Element `<tag attrs>children</tag>` | `tag attrs { children }` |
| Self-closing void `<br/>` | `br;` |
| Empty attribute `disabled` | `disabled;` (maud's boolean form) |
| Static attr `name="v"` | `name="v"` — maud will HTML-escape on render |
| Dynamic attr `name={expr}` | `name=(<emit_expr>)` |
| Renamed attr `className={x}` | `class=(<emit_expr>)` |
| Text node (post-normalize) | `"text"` — maud will HTML-escape on render |
| Expr child `{expr}` | `(<emit_expr>)` |
| Map child | `@for binding in &<source_path> { <body> }` |
| Number-literal text | `(value)` (i64) or `("value")` (str of fractional, see §5.2) |

`<emit_expr>` translation:
| IR | Rust |
|---|---|
| `Field(name)` | `&props.name` for `&String`; `props.name` for `Copy` types like i64 |
| `MapBinding(name)` | `&name` for `&String`; `name` for `Copy` |
| `MemberAccess { root, path }` where root is destructured prop | `&props.<root>.<path0>.<path1>...` for `&String` |
| `MemberAccess` where root is map binding | `&<root>.<path0>...` |
| `StaticText(s)` | `(<emit_static_str>)` — see §5.2 |
| `StaticNum(n)` | `(n)` (i64) |

### 5.2 Numeric and string-literal emit

Number literals from JSX are not annotated with type. To stay deterministic:
- Integer-valued number → `i64` literal `(42)`.
- Non-integer (`3.14`) → A1 errors `NonIntegerNumericNotSupported` — punted to A4 because float formatting differs between Rust and JS. Reviewer-flagged determinism risk.

String literals in expr position (e.g. `{"x"}`) → `("x")` in maud — passes through unchanged but still escaped by maud. Note that this is NOT a `PreEscaped` — to inject raw HTML you'd need `PreEscaped(...)` and A1 has no syntax for that.

### 5.3 Type inference for Props (v2 unchanged from v1)

For Phase A1:

| Use site | Inferred Rust type |
|---|---|
| `{name}` or `{name.field}` in JSX text or attr value, where field path bottoms out in a value position | `pub name: String` (or `pub name: { ... }` struct for member chains) |
| `{name.map((item) => ...)}` | `pub name: Vec<NameItem>` where `NameItem` is a generated struct whose fields are inferred from `item.<f>` use sites inside the map body |
| `{value.field1.field2}` where path reaches depth ≥ 2 | nested generated struct types — see §5.4 |

If two paths conflict (e.g. `{items}` text and `{items.map(...)}`) → `PropTypeConflict`. The reviewer's open question is resolved in §5.4.

### 5.4 Nested member path → struct emit

For a JSX referencing `{user.address.city}` where `user` is a destructured prop, generate:
```rust
pub struct UserAddress { pub city: String }
pub struct UserData { pub address: UserAddress }
pub struct Props { pub user: UserData }
```

Naming: each intermediate becomes `<PathPascalCased>` joined. Leaf assumed `String`. If multiple use sites name overlapping fields, merge field lists; if one path bottoms at `String` and another at a struct (e.g. `{x}` and `{x.y}`), → `PropTypeConflict`.

A1 fixtures keep depth ≤ 2 (`item.href`, `item.label`) so the nested-struct logic is tested but not load-bearing.

### 5.5 Empty `Props` and zero-prop components

`StaticHello` has no destructured props. Emit:
```rust
pub struct Props {}

pub fn render(_props: &Props) -> Markup {
    html! { … }
}
```

(`_props` prefix to silence unused-var warning. The signature is uniform so call sites are uniform across fixtures.)

## 6. Compile-time interface

```rust
// crates/jsx-rust-compiler/src/lib.rs
pub fn compile(source: &str) -> Result<String, CompileError>;
pub fn compile_with_path(source: &str, path: &str) -> Result<String, CompileError>;

#[derive(Debug, thiserror::Error)]
#[error("{path}:{line}:{col}: {kind}")]
pub struct CompileError {
    pub path: String,
    pub line: u32,    // 1-indexed
    pub col: u32,     // 1-indexed (UTF-16 code units to match swc's BytePos→line/col mapping)
    pub kind: ErrorKind,
}

#[derive(Debug, thiserror::Error)]
pub enum ErrorKind {
    #[error("parse error: {0}")] Parse(String),
    #[error("expected single `export default function`, found other top-level statement")] UnexpectedStatement,
    #[error("function body must be a single `return <jsx>;`")] BodyMustBeSingleReturn,
    #[error("unsupported function parameter pattern")] UnsupportedParam,
    #[error("custom component `<{0}/>` not supported in Phase A1")] CustomComponentNotSupported(String),
    #[error("namespaced JSX element not supported")] NamespacedElementNotSupported,
    #[error("member-expression JSX element not supported")] MemberComponentNotSupported,
    #[error("fragments not supported in Phase A1")] FragmentNotSupported,
    #[error("namespaced attribute not supported")] NamespacedAttrNotSupported,
    #[error("event handler `{0}` not supported (handled by islands in Phase A3)")] EventHandlerNotSupported(String),
    #[error("`ref` attribute not supported")] RefAttributeNotSupported,
    #[error("JSX in attribute position not supported")] JsxInAttrNotSupported,
    #[error("spread attribute not supported")] SpreadAttributeNotSupported,
    #[error("spread child not supported")] SpreadChildNotSupported,
    #[error("unresolved identifier `{0}` — only destructured props and `.map` iter-bindings are in scope")] UnresolvedIdent(String),
    #[error("bare identifier `{0}` in JSX not supported in Phase A1")] BareIdentNotSupported(String),
    #[error("computed member access not supported")] ComputedAccessNotSupported,
    #[error("template literals not supported in Phase A1")] TemplateLiteralNotSupported,
    #[error("function call expression not supported in Phase A1")] CallExpressionNotSupported,
    #[error("complex expression (binary/conditional/unary) not supported in Phase A1")] ComplexExpressionNotSupported,
    #[error("`.map((item, idx) => …)` two-arg form not supported in Phase A1")] MapIndexParamNotSupported,
    #[error("`.map(...)` shape not supported — expect `(ident) => <JSXElement>`")] MapShapeNotSupported,
    #[error("non-integer numeric literal not supported in Phase A1")] NonIntegerNumericNotSupported,
    #[error("void element `<{0}>` cannot have children")] VoidElementHasChildren(String),
    #[error("unknown attribute rename `{0}` — uppercase letters require a rename-table entry")] UnknownAttributeRename(String),
    #[error("prop `{0}` used as both value and collection — type conflict")] PropTypeConflict(String),
}
```

The lib only consumes `&str`. File I/O is in `bin/jsx-rustc.rs`. `compile_with_path` sets the path used in error display; `compile` defaults to `"<stdin>"`.

## 7. CLI surface (v2 — unchanged from v1)

```
jsx-rustc <input.tsx>           # emit Rust source to stdout
jsx-rustc <input.tsx> -o <out>  # write to <out>
jsx-rustc <input.tsx> --check   # parse only, print "OK" or error, exit 0/1
```

Errors: stderr in the format `<path>:<line>:<col>: <kind-message>`. Exit 0 on success, non-zero on parse/emit errors.

## 8. Runtime (v2 change — collapsed)

No separate runtime crate. The emitted Rust code depends on `maud = "0.27"` at the consumer crate (which in A1 is `tests/golden_render/`; in A2 will be the brust render path). The compiler crate itself does NOT need `maud` as a dependency — it just emits source that references it.

## 9. Tests

### 9.1 Unit tests (`src/*` `#[cfg(test)]`)

- `parser.rs`: source → swc Module sanity (just confirms the parser is configured correctly; not testing swc).
- `lower.rs`: per error case in §4.4, one test producing the expected `ErrorKind`. ~20 cases.
- `lower.rs`: positive lowering tests for each IR node kind, asserting on IR shape with `Debug`.
- `emit.rs`: per IR node, one snapshot of emitted maud syntax.

### 9.2 Integration — golden emit (`tests/golden_emit.rs`)

For each fixture in `fixtures/*.tsx`:
1. Read input.
2. `compile_with_path(&input, fixture_path)`.
3. Compare result to `<name>.expected.rs`. Use `pretty_assertions::assert_eq` for diff.

To update goldens: `UPDATE_GOLDEN=1 cargo test -p jsx-rust-compiler --test golden_emit`. CI never sets this.

### 9.3 Integration — golden render (`tests/golden_render/`)

(v2 change — `#[path = "..."]` mod hardened per reviewer.) `tests/golden_render/mod.rs` is a `mod` aggregator; one sub-module per fixture:

```rust
// tests/golden_render/mod.rs
mod static_hello;
mod props_hello;
mod list_nav;
```

```rust
// tests/golden_render/static_hello.rs
#[path = "../../fixtures/static_hello.expected.rs"]
mod fixture;

#[test]
fn renders_expected_html() {
    let props = fixture::Props {};
    let out = fixture::render(&props).into_string();
    let expected = include_str!("../../fixtures/static_hello.expected.html");
    pretty_assertions::assert_eq!(out, expected.trim_end_matches('\n'));
}
```

Each fixture's test constructs `Props` with known values (committed inside the test fn, NOT generated), calls `render().into_string()`, and compares to the committed `.expected.html`. The `.expected.html` was captured ONCE by running `cargo test … -- --ignored capture_html` (an `#[ignore]` test fn that re-renders and writes the file). Recapture is manual.

To update HTML goldens: temporarily un-`#[ignore]` the capture fn or use `UPDATE_GOLDEN=1`. Either way, CI never sets this.

### 9.4 Workspace gates

A1 must keep green:
- `cargo build --workspace` (macOS-arm64).
- `cargo test --workspace --lib`: 107 brust + ~30 jsx-rust-compiler unit = ~137 tests.
- `cargo test --workspace --lib --release`: same set, catches debug-only-assert regressions.
- `cargo test -p jsx-rust-compiler` (integration tests included).
- `bun run build` + `bun test runtime/` + targeted brust integration tests — unchanged.

## 10. Fixtures (input + expected emit + expected HTML)

(v2 change — expected emit is now maud syntax. Expected HTML is now what maud renders, NOT what React renders.)

### 10.1 `static_hello.tsx`

```tsx
export default function StaticHello() {
  return (
    <div>
      <h1>Hello from compiled Rust</h1>
      <p>This page is statically generated.</p>
    </div>
  )
}
```

Expected emit (`static_hello.expected.rs`):
```rust
use maud::{html, Markup};

pub struct Props {}

pub fn render(_props: &Props) -> Markup {
    html! {
        div {
            h1 { "Hello from compiled Rust" }
            p { "This page is statically generated." }
        }
    }
}
```

Expected HTML (`static_hello.expected.html`) — captured from maud once, committed:
```
<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>
```

### 10.2 `props_hello.tsx`

```tsx
export default function PropsHello({ title, body }) {
  return (
    <article>
      <h1>{title}</h1>
      <p>{body}</p>
    </article>
  )
}
```

Expected emit:
```rust
use maud::{html, Markup};

pub struct Props {
    pub title: String,
    pub body: String,
}

pub fn render(props: &Props) -> Markup {
    html! {
        article {
            h1 { (props.title) }
            p { (props.body) }
        }
    }
}
```

Expected HTML — fixture test calls render with `{title: "Hi", body: "Body <hi> & co"}`:
```
<article><h1>Hi</h1><p>Body &lt;hi&gt; &amp; co</p></article>
```

(maud escapes `<`, `>`, `&`, `"` — 4 chars, NOT `'`. This is the documented difference from React's 5-char set; non-load-bearing for A1 fixtures.)

### 10.3 `list_nav.tsx`

```tsx
export default function ListNav({ items }) {
  return (
    <nav>
      <ul>
        {items.map((item) => (
          <li>
            <a href={item.href}>{item.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

Expected emit:
```rust
use maud::{html, Markup};

pub struct ItemsItem {
    pub href: String,
    pub label: String,
}

pub struct Props {
    pub items: Vec<ItemsItem>,
}

pub fn render(props: &Props) -> Markup {
    html! {
        nav {
            ul {
                @for item in &props.items {
                    li {
                        a href=(item.href) { (item.label) }
                    }
                }
            }
        }
    }
}
```

Expected HTML — fixture test calls render with `items = [{href:"/a", label:"Alpha"}, {href:"/b", label:"Beta"}]`:
```
<nav><ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul></nav>
```

## 11. Acceptance criteria

1. `cargo build --workspace` succeeds on macOS-arm64. Linux not required for A1.
2. `cargo test -p jsx-rust-compiler` passes: ~30 unit tests + 3 golden_emit + 3 golden_render = ~36 tests.
3. `cargo test --workspace --lib` passes (107 brust + new jsx-rust-compiler unit = ~137).
4. `cargo test --workspace --lib --release` passes.
5. `cargo run -p jsx-rust-compiler --bin jsx-rustc -- crates/jsx-rust-compiler/fixtures/static_hello.tsx` prints bytes equal to `static_hello.expected.rs` (minus leading comment line).
6. Each `.expected.html` file matches `maud::Markup::into_string()` output for the same input — verified by the golden_render tests passing.
7. `bun run build` + `bun test runtime/` still green — A1 doesn't touch the napi build.
8. Each `ErrorKind` variant has at least one unit test in `lower.rs` producing it.
9. swc_core 68 compiles cleanly with the workspace's existing `serde = "1"`. If T1 finds a compat issue, the BLOCKED fallback in §15.1 fires before any other task runs.

## 12. Known limitations (shipped state)

- Dialect is tiny.
- maud's escape set is 4 chars (`<>&"`), not React's 5 (`<>&"'`). A1 documents the difference; A4+ revisits if real fixtures break.
- maud's void-element form is `<br>`, NOT `<br/>`. Differs from React's serializer. A1 documents.
- maud's attribute order = source order. Same as React.
- No HTML entity decoding in JSX text. `&nbsp;` in source → literal `&nbsp;` in output (NOT U+00A0). React decodes; we don't. Document for A4.
- No `<pre>`-aware whitespace preservation. JSX-level whitespace normalization runs uniformly.
- No source maps. Errors are `path:line:col` from swc spans; sufficient for A1.
- No incremental compilation cache. Each call to `compile()` reparses.
- Non-integer numeric literals in JSX errored (`NonIntegerNumericNotSupported`). Punted to A4.

## 13. Open questions — resolved

1. **Q (reviewer): React `'` escape** — moot. Dropping React byte-equivalence; trust maud's 4-char set.
2. **Q (reviewer): void element form** — moot. maud emits `<br>`, that's the truth.
3. **Q (reviewer): reserve calc** — moot. maud manages its own buffer.
4. **Q (reviewer): PropTypeConflict for items used both as map source and value** — explicit `PropTypeConflict` per §5.3. Detected by the type-inference pass before emit.
5. **Q (reviewer): one-shot capture vs recurring** — one-shot. `.expected.html` is committed and updated only on dialect/fixture changes. CI compares; CI does not recapture.
6. **Q (reviewer, v2): inline TS type annotations like `({ a }: { a: string })`** — the lower pass type-erases the param type. The `swc_ecma_parser` configured with `tsx: true` already accepts inline types in the AST; we ignore the `type_ann` field. ✓
7. **Q (reviewer, v2): map two-arg form** — explicit `MapIndexParamNotSupported` per §4.4.
8. **Q (v2): swc_core compat with workspace serde** — T1 verifies. §15.1 BLOCKED fallback.

## 14. Internal consistency check

(v2 — after rewrite, verify each cross-reference.)

- §3 layout matches §9 test paths: ✓
- §4 lowering rules cover every `ErrorKind` in §6: ✓ (cross-checked).
- §5 emit rules cover every IR node introduced in §4: ✓.
- §10 expected emits use the maud-syntax forms from §5.1: ✓.
- §11 acceptance criteria match the test gates in §9.4: ✓.
- Crate name `jsx-rust-compiler`, package name `jsx-rust-compiler`, lib `jsx_rust_compiler` (with hyphen→underscore), binary `jsx-rustc`. No `jsx_rust_runtime` mention anywhere — collapsed in v2.

## 15. Blocked fallback (per ny-auto-pipeline discipline)

### 15.1 swc_core 68 fails to compile against workspace serde

Symptom: `cargo build -p jsx-rust-compiler` errors with anything mentioning `serde::__private`, `serde_derive` macro mismatch, or any `swc_common`-internal compat.

First diagnostic step (debug-mantra step 3, falsify): build with `cargo build -p jsx-rust-compiler --verbose` and inspect which crate is failing. If it's NOT swc, the failure is elsewhere and §15.1 doesn't apply.

Recovery order, attempt in sequence:
1. Add a workspace-level resolver pin: `serde = "=1.0.215"` in `crates/jsx-rust-compiler/Cargo.toml` (NOT the workspace root — local to the compiler crate). Verify brust crate still builds with the default `serde = "1"` resolution. Cargo's resolver MAY downgrade workspace-wide; if it does, this approach is dead.
2. Pin to the LATEST serde that swc_core 68 builds against — likely the 1.0.219 line per swc's known compat tables. Document the pin in `Cargo.toml` with a comment.
3. Drop `swc_core` and use the lower-level crates directly: `swc_ecma_parser = "version_pulled_in_by_swc_core_68"` + `swc_ecma_ast` + `swc_common` separately. Smaller surface, but loses the bundled-version guarantee.
4. ESCALATE to advisor — the compat issue may have changed shape since swc_core 68 was uploaded. The two-attempts rule applies here per ny-auto-pipeline: if (1) AND (2) both fail and (3) introduces new compat noise, advisor must adjudicate before pivoting back to hand-rolled.

The HARD floor before hand-rolling: two real attempts on the same swc-compat root cause must fail. Only then does v1's hand-rolled approach come back on the table, and only with explicit advisor sign-off.

### 15.2 maud golden HTML doesn't match expectation

Symptom: golden_render test fails on a fixture the first time — the `expected.html` was captured wrong, or maud's output differs from what the spec predicted.

Recovery:
1. `UPDATE_GOLDEN=1 cargo test -p jsx-rust-compiler --test golden_render -- <name>` to re-capture, commit the new bytes.
2. Eyeball the diff. If it's whitespace, escape-set, or void-form: document in §12.
3. If it's a semantic mismatch (wrong attribute, wrong text): emit bug — fix `emit.rs`, re-run, re-capture.

## 16. Out of scope — never doing in the compiler

- React hooks, state, refs. Phase A3 handles client-side via islands.
- Type checking. `tsc` upstream is the type authority.
- Style sheets, Tailwind. Existing pipeline handles.
- Server-side data fetching. A2 owns the loader bridge.

---

End of spec v2. Reviewer next.
