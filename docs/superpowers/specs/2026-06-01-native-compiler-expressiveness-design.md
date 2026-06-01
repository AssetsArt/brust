# Native Compiler Expressiveness — Cluster A (S11 / S1 / S8)

> **Status:** spec · 2026-06-01 · branch `framework-gaps`
> **Source of gaps:** `example/pokedex/FRAMEWORK-GAPS.md`
> **Scope:** the JSX→jinja compiler only (`crates/jsx-rust-compiler/src/`). No Rust
> server change, no TS runtime change.

This is the first of three sub-projects that close the gaps catalogued while
dogfooding the PokéDex. The roadmap:

- **Cluster A (this spec)** — compiler expressiveness: S11 conditionals, S1 style
  object, S8 dynamic head props.
- **Cluster B (later)** — Rust server: S12 (DELETE 411), S9 (notFound/redirect +
  native status), static `public/`, boot-time native compile, dev island cache.
- **Cluster C (later)** — TS runtime: S7 (typed errors), S4 (`createIslandStore`),
  S6 (request/session ctx), S2 (loader cache), native layout/Outlet.

Each cluster gets its own spec → plan → implementation cycle. Clusters B and C are
**out of scope** here and are named only so the boundary is explicit.

---

## Goal

Let a native (`native: true`) route author write three things that today force a
loader-side workaround, lifting the "native route = member-path + `.map()` only"
ceiling described in the gaps doc:

1. **S11 — conditionals** in a route body: `{cond && <X/>}` and
   `{cond ? <A/> : <B/>}`, where `cond` may be a member-path truthiness check, a
   negation (`!path`), or a comparison/logical expression
   (`x.n > 0`, `a === b`, `p && q`).
2. **S1 — `style={{…}}` object** attributes, with values that are string/number
   literals or member-paths, applying React's auto-`px` rule to numeric literals.
3. **S8 — dynamic `<BrustPage>` head props**: `title` / `description` / `lang` /
   `className` / `bodyClassName` accept a member-path, not just a string literal.

Success = the PokéDex pages drop their `xxxClass`/`heroStyle`/static-title
workarounds and use these forms directly, still compiling to jinja and rendering
in Rust with zero React on the server shell.

## Non-goals

- **No new emit-layer expression language.** `emit_jinja::emit_expr_path` already
  renders `Compare` / `Logical` / `Not` / `Arith` / `Concat` / `Filter` to valid
  jinja (with existing unit tests `compare_gt`, `logical_and`, `concat_template`).
  This work routes *more inputs* into that existing IR; it does not extend jinja
  output semantics.
- **No arithmetic/filter/template-literal in route bodies beyond what a cond-test
  or style value needs.** Those remain inline-only (`scope.inline.is_some()`).
  Specifically out of scope: `{a + b}` as a text node, `.map().filter()` chains,
  template literals as text on a native route.
- **No `style` shorthand expansion, vendor prefixing, or CSS validation.** We
  serialize what the author wrote.
- **No auto-`px` for member-path style values** — a runtime value's numeric-ness
  is unknowable at compile time. Auto-`px` applies to numeric *literals* only;
  member-path values are emitted verbatim (the loader/author supplies units).
- Clusters B and C (see roadmap).

## High-level architecture

All three features share one insight confirmed by reading the compiler: **the IR
and the emitter are already capable; the lowering gates are what reject these
inputs on native routes.**

| Layer | S11 conditionals | S1 style object | S8 dynamic head |
|---|---|---|---|
| `ir.rs` | none (`JsxNode::Cond`, `Expr::{Compare,Logical,Not}` exist) | none (reuse `AttrValue::{Static,Expr}` + `Expr::Concat`) | **change** `Document` fields `Option<String>` → `Option<HeadValue>` |
| `lower.rs` | **change** lift cond-recognition out of inline gate + new `lower_cond_test` | **change** new `style` intercept in `lower_attr` + `lower_style_object` | **change** `lower_brust_page` accepts member-path |
| `emit_jinja.rs` | **none** (already emits `{% if … %}`) | **none** (`AttrValue::Expr(Concat)` already emits `style="{{ … }}"`) | **change** `Document` arm emits `{{ path }}` for `HeadValue::Path` |

### S11 — conditionals on native route body

Today `lower_child` recognizes `{cond && <JSX>}` and `{cond ? <A> : <B>}` only
inside `if scope.inline.is_some()` (`lower.rs:1920-1963`). A native **route** body
has `scope.inline == None`, so the expression container falls through to
`lower_expr`, where `SwcExpr::Cond` → `ComplexExpressionNotSupported` and
`SwcExpr::Bin`/`Unary` are also inline-gated.

**Change:** move the two cond-recognition blocks so they run for native route
bodies too (not only inline). For the **test** position, introduce
`lower_cond_test(expr, scope)` that is permitted in native scope and accepts a
restricted grammar:

```
cond_test := member_path                       // truthiness  → {% if path %}
           | "!" member_path                    // negation    → {% if not path %}
           | operand cmp_op operand             // comparison  → {% if (a) > (b) %}
           | cond_test logic_op cond_test        // and/or      → {% if (a) and (b) %}
operand   := member_path | string_lit | int_lit
cmp_op    := > | < | >= | <= | === | == | !== | !=   (=== → ==, !== → !=)
logic_op  := && | ||                                  (&& → and, || → or)
```

**Call-site precision (load-bearing).** The two lifted recognition blocks must
call `lower_cond_test(&bin.left, scope)` (for `{cond && <X>}`) and
`lower_cond_test(&cond_expr.test, scope)` (for the ternary) — **NOT** `lower_expr`.
`lower_expr`'s `SwcExpr::Bin`/`Unary`/`Cond` arms stay inline-gated
(`lower.rs:2268-2301`); routing the test through `lower_expr` on a native route
would re-reject `{d.n > 0 && …}` with `ComplexExpressionNotSupported`. `lower_cond_test`
is the *only* entry that lowers a comparison/logical/negation test outside inline mode.

`lower_cond_test` accepts exactly:

- a **truthiness leaf** — `lower_cond_operand` yielding `Field` / `MemberAccess` /
  `MapBinding` / `MapMember` / `StaticText` / `StaticNum` (covers `{flag && …}`,
  `{d.notFound ? …}`, and `{item.active && …}` / `{item && …}` inside `.map()`).
- `SwcExpr::Unary` with `op == !` → `Expr::Not(Box::new(lower_cond_test(arg)))`.
- `SwcExpr::Bin` with a **comparison** op (`>`,`<`,`>=`,`<=`,`===`,`==`,`!==`,`!=`)
  → `Expr::Compare`, mapping `===`→`Eq`, `!==`→`Ne`; both operands lowered via
  `lower_cond_operand` (member-path/literal **only**).
- `SwcExpr::Bin` with a **logical** op (`&&`,`||`) → `Expr::Logical{And|Or}`; both
  sides recurse through `lower_cond_test` (so `{a.x && b.y}` and `{a || !b}` work).
- `SwcExpr::Paren` → recurse.
- anything else (calls, arithmetic, template literals, object) →
  `ComplexExpressionNotSupported`.

`lower_cond_operand` is a **dedicated restricted lowerer** (not a reuse of
`lower_bin_inline`, whose operand path delegates to `lower_expr` and would admit
arithmetic). It yields only member-path / map-member / string-or-int literal; an
arithmetic or call operand → `ComplexExpressionNotSupported`. This is what keeps
`{a + b > 0 && …}` rejected while `{a.n > 0 && …}` is accepted (resolves review O2).

The resulting `JsxNode::Cond { test, consequent, alternate }` is emitted unchanged
by the existing `emit_node` arm (`emit_jinja.rs:135-147`, via `emit_expr_path`
which already renders `Compare`/`Logical`/`Not` — `emit_jinja.rs:266-297`).

**Branch bodies** (`consequent`/`alternate`) are lowered through the normal
`lower_child` path, so a branch may be a JSX element, a **fragment** (`<>…</>`),
or itself contain `.map()`, islands, or further conditionals. The recognition must
therefore accept both `SwcExpr::JSXElement` and `SwcExpr::JSXFragment` branches
(today's inline code at `lower.rs:1951` only matches `JSXElement` — widen it).
A `null` / `false` / `undefined` branch (`{cond ? <A/> : null}`) lowers that branch
to `JsxNode::Empty` rather than falling through to `ComplexExpressionNotSupported`
(resolves review F2/O3).

### S1 — `style={{…}}` object attribute

In `lower_attr`, **after** `rename_attr` resolves `final_name` (style is not in
the rename table, so `final_name == "style"` == `raw_name == "style"` today —
intercepting on `final_name` is correct and future-proof), intercept the case
`final_name == "style"` **and** the value is `JSXExprContainer(Expr(Object))`.
Route it to `lower_style_object(obj, scope)`:

For each `ObjectLit` property (must be `KeyValue`; `Shorthand`/`Spread`/computed
key → `StyleObjectNotSupported`):

- **key** → CSS property name: a plain ident or string key, camelCase → kebab-case
  (`backgroundColor` → `background-color`; a `--custom` / already-kebab key passes
  through). A leading vendor segment like `WebkitTransform` → `-webkit-transform`.
- **value**:
  - string literal → used verbatim.
  - number literal → stringified; append `px` **unless** the (camelCase) property
    is in the React unitless set (see below).
  - member-path (`Member`/`Ident` resolving to a prop/map binding) → an `Expr`
    interpolation piece, emitted verbatim (no auto-`px`).
  - anything else (object, call, arithmetic, template literal) →
    `StyleObjectValueNotSupported`.

Assemble the declaration string `"<prop>:<val>;<prop>:<val>"`. Then:

- **all-literal** → `AttrValue::Static("background-color:red;width:62px")`.
- **any member-path** → `AttrValue::Expr(Expr::Concat([...]))` whose pieces are
  `StaticText` for the literal CSS segments and the member-path `Expr` for dynamic
  values. The existing `emit_attr` arm for `AttrValue::Expr` renders this as
  `style="{{ "background-color:red;width:" ~ st.w ~ ";padding:16px" }}"` — valid
  jinja that concatenates to the right declaration string. The runtime value is
  emitted verbatim, identical to every other member-path attribute in brust today
  (`href="{{ item.href }}"`) — see **Escaping contract** below.

**React unitless set** (numeric literal → no `px`). Embedded as a `const &[&str]`
in `lower.rs`, matching React DOM's `isUnitlessNumber`:

```
animationIterationCount, aspectRatio, borderImageOutset, borderImageSlice,
borderImageWidth, boxFlex, boxFlexGroup, boxOrdinalGroup, columnCount, columns,
flex, flexGrow, flexPositive, flexShrink, flexNegative, flexOrder, gridArea,
gridRow, gridRowEnd, gridRowSpan, gridRowStart, gridColumn, gridColumnEnd,
gridColumnSpan, gridColumnStart, fontWeight, lineClamp, lineHeight, opacity,
order, orphans, scale, tabSize, widows, zIndex, zoom,
fillOpacity, floodOpacity, stopOpacity, strokeDasharray, strokeDashoffset,
strokeMiterlimit, strokeOpacity, strokeWidth
```

Comparison against this set uses the original camelCase key (before kebab
conversion). `MozOpacity`/`msFlex`-style prefixed unitless props are not in
React's list and so receive `px`; this matches React.

### S8 — dynamic `<BrustPage>` head props

New IR type in `ir.rs`:

```rust
#[derive(Debug, Clone)]
pub enum HeadValue {
    Literal(String),   // title="PokéDex"
    Path(Expr),        // title={data.title} — Expr restricted to member-path
}
```

`JsxNode::Document` fields `lang` / `html_class` / `body_class` / `title` /
`description` change from `Option<String>` to `Option<HeadValue>`.

In `lower_brust_page` (`lower.rs:627`), the per-prop value match accepts:

- `JSXAttrValue::Str(s)` → `HeadValue::Literal(s)` (today's path).
- `JSXAttrValue::JSXExprContainer(Expr(e))` where `e` lowers to a member-path
  (`Field` / `MemberAccess`) → `HeadValue::Path(expr)`.
- anything else → `BrustPageAttrMustBeStringLiteral` (kept; map bindings make no
  sense in the route-root head, calls/arithmetic stay rejected). Error message
  text may be broadened to "string literal or member-path".

The `lang` default (`"en"` when omitted) becomes `HeadValue::Literal("en")`.

In `emit_jinja`'s `Document` arm, each slot branches on `HeadValue`:

- `Literal(s)` → today's pre-escaped output (`push_html_escaped` for `<title>`,
  `push_attr_escaped` for `lang`/`class`/`description`).
- `Path(e)` → `{{ <emit_expr_path(e)> }}` placed in the slot:
  `<title>{{ title }}</title>`, `<html lang="{{ lang }}" class="{{ html_class }}">`,
  `<meta name="description" content="{{ description }}"/>`,
  `<body class="{{ body_class }}">`. The runtime value is emitted verbatim,
  consistent with all existing member-path interpolation in brust (`Literal` values
  keep their compile-time `push_*_escaped`) — see **Escaping contract** below.

The mechanical emitter change: each `if let Some(l) = lang { … }` becomes
`if let Some(hv) = lang { match hv { Literal(s) => push_attr_escaped/push_html_escaped(out, s), Path(e) => write!(out, "{{{{ {} }}}}", emit_expr_path(e)) } }`.
The `lang` default at `lower.rs:677` becomes `Some(HeadValue::Literal("en".into()))`
so the `Literal` arm always covers the default (resolves review F3/F4).

## Behavioral invariants

- **Inline mode is unchanged.** Existing `<Comp native/>` expansion still produces
  byte-identical jinja. The S11 change *adds* a native-route path; it must not
  alter the inline path. Regression guard: existing inline cond tests stay green.
- **Determinism.** Output remains single-line and byte-stable (golden fixtures
  compare byte-for-byte).
- **Escaping contract** (REVISED post-security-review, commit `5a4c4ca`). brust's
  minijinja runs with `AutoEscape::None` (`crates/brust/src/jinja.rs`
  `Environment::new()`, templates registered by stem, no `.html` extension), so
  escaping is NOT automatic. The original draft of this spec said dynamic values
  render *verbatim* under a "loader-data-trusted" contract — that was **WRONG** and
  was a real HIGH XSS: loader data routinely derives from request params (route
  `:name`) / third-party APIs, and a raw `<script>` in the URL path reached
  `<title>`/text nodes unescaped (proven in the dogfood). **Corrected behavior:**
  the emitter wraps every dynamic value in an HTML-OUTPUT position as
  `{{ (expr) | e }}` (`emit_escaped_interp`) — text nodes, host-element attributes,
  S1 style objects, S8 head props. Parenthesized so a `Concat`/`Filter` escapes its
  final string. NOT escaped (correct): control-flow (`{% for %}`, `{% if %}` tests)
  and pre-rendered HTML slots (`… | safe`), plus the pre-escaped `island_N_props`.
  No AutoEscape mode change — the explicit `| e` keeps golden-render test fidelity.
  minijinja `| e` also escapes `/` → `&#x2f;` in URLs (browser-decoded, safe).
- **Rejection still bites for genuinely unsupported forms.** Calls, arithmetic-as-text,
  template literals, spreads, computed keys, nested style objects → existing or
  new typed errors, not silent drops.

## Tests

Per feature, three layers (TDD — failing test first):

**S11**
- `lower.rs` unit: `{flags.hasPrev && <a/>}` on a non-inline route → `JsxNode::Cond`
  with `test = Field/MemberAccess`. `{d.n > 0 && <b/>}` → `test = Compare{Gt}`.
  `{!d.empty ? <a/> : <b/>}` → `test = Not(...)`, `alternate = Some`.
- `lower.rs` reject: `{foo() && <a/>}` → `ComplexExpressionNotSupported`;
  `{a + b ? … : …}` test with arithmetic → rejected.
- regression: the existing "THE GATE" test (`lower.rs:4377`) is updated/replaced —
  a bare `{show && <span/>}` on a native route now **succeeds** (was the gate
  assertion). Keep an inline-mode equivalent green.
- golden fixture: a route with `&&`, ternary, and a comparison → committed
  `.jinja` golden, rendered through real minijinja with a context.

**S1**
- `lower.rs` unit: `style={{ width: 62 }}` → `AttrValue::Static("width:62px")`;
  `style={{ opacity: 1 }}` → `"opacity:1"` (unitless); `style={{ color: c.fg }}` →
  `AttrValue::Expr(Concat([...]))`; mixed literal+path ordering preserved.
- `lower.rs` reject: spread `{{...x}}`, computed key `{{[k]: v}}`, nested
  `{{ a: { b: 1 } }}` → `StyleObject*NotSupported`.
- `emit_jinja` unit: the `Concat` style value → expected `style="{{ … ~ … }}"`.
- edge: a literal style value containing `"` (e.g. `content: '""'`) → confirm the
  `Concat` `StaticText` quoting (`emit_jinja.rs:245`) escapes it soundly.
- golden fixture: static + dynamic style on one element.

**S8**
- `lower.rs` unit: `title={data.title}` → `Document.title = HeadValue::Path(...)`;
  `title="x"` → `HeadValue::Literal("x")`; default lang → `Literal("en")`.
- `emit_jinja` unit: `Path` title → `<title>{{ title }}</title>`; `Path` lang →
  `lang="{{ lang }}"`.
- golden fixture: a `<BrustPage title={d.title} description={d.desc}>` document.

**End-to-end dogfood (acceptance):** convert `example/pokedex/pages/*.tsx` to use
real conditionals / `style={{…}}` / dynamic title, delete the corresponding
loader workarounds (`prevClass`/`nextClass`/`contentClass`/`notFoundClass`/
`heroStyle`/static title), `brust build` the example, boot it, and verify in a
browser: list/detail/type-chart render, pagination disable state correct, 404
block shows for a bad name, `<title>` is per-page (`Charizard · PokéDex`).

## Acceptance criteria

1. `cargo test -p jsx-rust-compiler` green, including new unit + golden fixtures.
2. `cargo fmt --check` and `cargo clippy --all-targets --locked -D warnings` clean
   on the crate.
3. A native route using `{cond && …}`, `{a ? b : c}` with comparison/logical
   tests, `style={{…}}` (literal + member-path), and `<BrustPage title={path}>`
   compiles and produces correct jinja (golden-verified).
4. Inline-mode (`<Comp native/>`) output is byte-identical to pre-change (no
   regression in existing fixtures/tests).
5. PokéDex example rebuilt with the workarounds removed renders correctly in a
   browser (manual smoke, captured).
6. `bun run ci` (biome) clean on any `.tsx` touched in the example.

## Known limitations (documented, not fixed here)

- Cond-test grammar excludes calls, arithmetic, filters, template literals — by
  design. A test needing those still precomputes a boolean in the loader.
- Auto-`px` does not apply to member-path style values.
- `style` strings are not validated or shorthand-expanded.
- Nested `style` objects and computed keys are rejected.
- The `○ nested .map()` gap (type-chart) is a separate fixture concern, tracked
  but not required for Cluster A acceptance.
- ~~No output escaping~~ SUPERSEDED: a framework-wide `| e` escaping pass WAS added
  (commit `5a4c4ca`) after a security review flagged the original verbatim plan as
  XSS. All dynamic HTML output is now HTML-escaped at runtime. See the revised
  Escaping contract above.

## Open questions resolved at plan time

- **Exact React unitless list provenance** — pin to React 19's `isUnitlessNumber`;
  the list above is the canonical set. Plan task will cite the upstream source.
- **`lower_cond_test` reuse vs. ungating `lower_expr`** — plan uses a dedicated
  `lower_cond_test` + `lower_cond_operand` (surgical) rather than ungating
  `lower_expr` or reusing `lower_bin_inline`, to keep arithmetic/calls rejected in
  test position. Confirmed by reading `lower_expr`'s inline gates (review O2).
- **Autoescape** — verified OFF (`AutoEscape::None`); resolved to the trusted-loader
  contract above rather than adding `| e` to 3 props (review B1/B2/O1).
- **Cond test/branch call sites** — `lower_cond_test` on `bin.left`/`cond.test`;
  branches accept JSXElement/JSXFragment/`null` (review B3/F1/F2/O3).
