# Implementation Plan — Native Compiler Expressiveness (Cluster A)

> Spec: `2026-06-01-native-compiler-expressiveness-design.md`
> Crate: `crates/jsx-rust-compiler` · base SHA at plan time: `3ac1b1b`
> Public entry: `jsx_rust_compiler::compile(source) -> Result<String, CompileError>` (`src/lib.rs:11`)
> `ErrorKind` (thiserror): `src/lib.rs:507`
> Golden fixtures: `fixtures/<name>.tsx` + `fixtures/<name>.expected.jinja`; names listed in
> `tests/golden_emit_jinja.rs` `FIXTURES`; render tests in `tests/golden_render_jinja/main.rs`.
> Regenerate goldens after an INTENTIONAL emit change: `UPDATE_GOLDEN=1 cargo test -p jsx-rust-compiler`.

## Verify commands (every task ends green on these)

```bash
cd /Users/detoro/code/brust
cargo test -p jsx-rust-compiler                                   # unit + golden
cargo fmt -p jsx-rust-compiler -- --check                         # fmt
cargo clippy -p jsx-rust-compiler --all-targets --locked -- -D warnings   # CI gate (release-mirror memory)
```

> NOTE (memory `release-mirror-ci-gates`): CI clippy is `--all-targets --locked -D warnings`. Run exactly that, not a looser form.

## Spec-coverage map

| Spec section | Task |
|---|---|
| S11 conditionals (lower_cond_test, lift gate, branches) | Task 1 |
| S1 style object (intercept, serialize, auto-px, errors) | Task 2 |
| S8 dynamic head (HeadValue IR, lower, emit) | Task 3 |
| End-to-end dogfood / acceptance | Task 4 |
| Escaping contract (verbatim, no new behavior) | inherent — no code; assert no `| e` added |

---

## Task 1 — S11: conditionals in native route body

**Files:** `src/lower.rs` (impl + unit tests), `fixtures/cond_native.tsx`,
`fixtures/cond_native.expected.jinja`, `tests/golden_emit_jinja.rs` (FIXTURES += "cond_native"),
optionally a render test in `tests/golden_render_jinja/main.rs`.
**Emit layer: NO CHANGE** — `emit_jinja.rs:135-147` + `emit_expr_path` already render `Cond`/`Compare`/`Logical`/`Not` (existing tests `compare_gt`, `logical_and`).

### 1a — RED: failing unit tests in `src/lower.rs` `#[cfg(test)]`

Add tests asserting native-route (NON-inline) lowering. Use the crate's existing test
helper for compiling a route body to IR (find the helper used by the gate test at
`lower.rs:4377`, e.g. `lower_route(src)` / `compile`-to-IR — match its exact name/signature).

```rust
// {flags.hasPrev && <a/>} on a native route → Cond{ test: MemberAccess, alternate: None }
// {d.n > 0 && <span/>}    → Cond{ test: Compare{Gt, MemberAccess, StaticNum(0)} }
// {!d.empty ? <a/> : <b/>}→ Cond{ test: Not(MemberAccess), alternate: Some }
// {a.x && b.y && <i/>}    → Cond{ test: Logical{And, .., ..} }
// inside .map: {items.map(it => it.active && <li/>)} → Map{ body: Cond{ test: MapMember } }
// {cond ? <A/> : null}    → Cond{ alternate: Some(Empty) }  (or consequent/Empty as written)
// {cond ? <>x</> : <b/>}  → Cond with Fragment consequent
// REJECT: {foo() && <a/>}     → ComplexExpressionNotSupported
// REJECT: {a + b > 0 && <a/>} → ComplexExpressionNotSupported  (arith operand)
```

Also UPDATE the existing GATE test (`lower.rs:4377`, "THE GATE"): a bare
`{show && <span/>}` on a native route now **succeeds** → assert it yields `Cond`,
not `Err`. Keep/add an inline-mode equivalent that still passes (regression guard:
inline output unchanged).

Run `cargo test -p jsx-rust-compiler` → these FAIL (red).

### 1b — GREEN: implementation in `src/lower.rs`

1. In the `lower_child` JSX-expr-container handler (`lower.rs:1904-1966`), MOVE the
   `{cond && <JSX>}` block (currently `1932-1944`) and the ternary block
   (`1946-1962`) OUT of the `if scope.inline.is_some()` guard so they run for native
   route bodies too. Keep the inline-only `{children}` ChildrenSlot case inside the
   guard. The `&&`/ternary blocks must come BEFORE the final
   `Ok(Some(JsxNode::Expr(lower_expr(e, scope)?)))` fallthrough.
2. Change the test lowering inside both blocks from `lower_expr(&bin.left, scope)?` /
   `lower_expr(&cond_expr.test, scope)?` to **`lower_cond_test(&bin.left, scope)?`** /
   **`lower_cond_test(&cond_expr.test, scope)?`**.
3. Widen branch matching: accept `SwcExpr::JSXElement` **and** `SwcExpr::JSXFragment`
   for consequent/alternate (route both through `lower_child`/`lower_element` +
   `lower_fragment`). For a `null`/`false`/`undefined` (`Lit::Null` / `Ident "undefined"`
   / `Lit::Bool(false)`) branch, lower to `JsxNode::Empty`.
4. Add the two new functions:

```rust
/// Lower a conditional TEST (the `cond` in `{cond && …}` / `{cond ? … : …}`).
/// Permitted OUTSIDE inline mode, unlike `lower_expr`'s Bin/Unary arms. Grammar:
/// member-path truthiness | `!test` | comparison | logical(and/or).
fn lower_cond_test(expr: &SwcExpr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    match strip_paren(expr) {
        SwcExpr::Unary(u) if u.op == UnaryOp::Bang => {
            Ok(crate::ir::Expr::Not(Box::new(lower_cond_test(&u.arg, scope)?)))
        }
        SwcExpr::Bin(b) => match b.op {
            // comparison → Compare; operands are member-path/literal only
            BinaryOp::Gt | BinaryOp::Lt | BinaryOp::GtEq | BinaryOp::LtEq
            | BinaryOp::EqEqEq | BinaryOp::EqEq | BinaryOp::NotEqEq | BinaryOp::NotEq => {
                let op = match b.op {
                    BinaryOp::Gt => CmpOp::Gt, BinaryOp::Lt => CmpOp::Lt,
                    BinaryOp::GtEq => CmpOp::Ge, BinaryOp::LtEq => CmpOp::Le,
                    BinaryOp::EqEqEq | BinaryOp::EqEq => CmpOp::Eq,
                    BinaryOp::NotEqEq | BinaryOp::NotEq => CmpOp::Ne,
                    _ => unreachable!(),
                };
                Ok(crate::ir::Expr::Compare {
                    op,
                    lhs: Box::new(lower_cond_operand(&b.left, scope)?),
                    rhs: Box::new(lower_cond_operand(&b.right, scope)?),
                })
            }
            // logical → Logical; both sides recurse as tests
            BinaryOp::LogicalAnd | BinaryOp::LogicalOr => {
                let op = if b.op == BinaryOp::LogicalAnd { LogOp::And } else { LogOp::Or };
                Ok(crate::ir::Expr::Logical {
                    op,
                    lhs: Box::new(lower_cond_test(&b.left, scope)?),
                    rhs: Box::new(lower_cond_test(&b.right, scope)?),
                })
            }
            _ => Err(LowerError::at(b.span, ErrorKind::ComplexExpressionNotSupported)),
        },
        // bare truthiness leaf
        other => lower_cond_operand(other, scope),
    }
}

/// Lower a comparison operand / truthiness leaf: member-path, map binding/member,
/// or string/int literal ONLY. Arithmetic, calls, etc. → rejected. This is the
/// surgical restriction that keeps `{a + b > 0}` out while allowing `{a.n > 0}`.
fn lower_cond_operand(expr: &SwcExpr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    match strip_paren(expr) {
        SwcExpr::Ident(_) | SwcExpr::Member(_)
        | SwcExpr::Lit(Lit::Str(_)) | SwcExpr::Lit(Lit::Num(_)) => lower_expr(expr, scope),
        other => Err(LowerError::at(other.span(), ErrorKind::ComplexExpressionNotSupported)),
    }
}
```

> `lower_expr` already resolves `Ident`/`Member` to `Field`/`MemberAccess`/`MapBinding`/
> `MapMember` and literals to `StaticText`/`StaticNum` (`lower.rs:2194-2228`), and
> rejects non-integer numerics — reuse it for leaves so map-binding resolution is
> identical to everywhere else. `lower_cond_operand` is the gate: it only forwards the
> safe `SwcExpr` shapes to `lower_expr`, rejecting Bin/Call/Unary/Tpl/Object operands.

Confirm imports exist for `UnaryOp`, `BinaryOp`, `CmpOp`, `LogOp`, `Lit`, `strip_paren`.

### 1c — golden fixture

`fixtures/cond_native.tsx`: a native route default-export component whose body uses
`{flag && <span/>}`, a ternary with comparison, and a `.map` with a per-item cond.
Generate the expected jinja with `UPDATE_GOLDEN=1`, then EYEBALL the `.expected.jinja`
to confirm `{% if … %}{% else %}{% endif %}` is correct before committing. Add
`"cond_native"` to `FIXTURES`.

### 1d — verify + commit

Run the three verify commands. Commit: `feat(compiler): allow conditionals in native route body (S11)`.

**BLOCKED fallback:** if the route-body test position turns out to be lowered through a
path other than `lower_child` (e.g. a dedicated route-root lowerer that doesn't call
`lower_child` for top-level children), trace from `compile()` → `lower()` to find where
route-body children are lowered, and place the lifted blocks there. Do NOT ungate
`lower_expr` globally as a shortcut — that would admit arithmetic-as-text and break the
Non-goals.

---

## Task 2 — S1: `style={{…}}` object attribute

**Files:** `src/lib.rs` (2 new `ErrorKind` variants), `src/lower.rs` (intercept +
`lower_style_object` + `css_kebab` + `UNITLESS` const + tests), `fixtures/style_object.tsx`
+ `.expected.jinja`, FIXTURES += "style_object".
**Emit layer: NO CHANGE** — `AttrValue::Static` and `AttrValue::Expr(Concat)` already emit
correctly (`emit_attr` `emit_jinja.rs:302-337`; `Concat` `emit_expr_path` `:241-249`).

### 2a — RED: tests in `src/lower.rs`

```rust
// style={{ width: 62 }}        → AttrValue::Static("width:62px")
// style={{ opacity: 1 }}       → AttrValue::Static("opacity:1")            (unitless)
// style={{ zIndex: 5 }}        → "z-index:5"                               (unitless + kebab)
// style={{ backgroundColor:'red', width: 62 }} → "background-color:red;width:62px" (order preserved)
// style={{ color: c.fg }}      → AttrValue::Expr(Concat([StaticText("color:"), MemberAccess(c.fg)]))
// style={{ width: st.w, color:'red' }} → Concat preserves mixed order
// REJECT: style={{ ...x }}      → StyleObjectNotSupported
// REJECT: style={{ [k]: 1 }}    → StyleObjectNotSupported  (computed key)
// REJECT: style={{ a: { b: 1 } }} → StyleObjectValueNotSupported (nested object)
// REJECT: style={{ w: fn() }}   → StyleObjectValueNotSupported (call value)
```

### 2b — GREEN

1. `src/lib.rs` ErrorKind (after the style-relevant group), thiserror messages:
```rust
#[error("`style` object: only `key: value` entries are supported (no spread/computed keys)")]
StyleObjectNotSupported,
#[error("`style` object value not supported — use a string/number literal or a member-path")]
StyleObjectValueNotSupported,
```
2. `src/lower.rs` `lower_attr`: after `final_name` is computed (`lower.rs:1815-1826`) and
   BEFORE the generic `value = match &jsx_attr.value` block, add:
```rust
if final_name == "style"
    && let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value
    && let JSXExpr::Expr(e) = &c.expr
    && let SwcExpr::Object(obj) = strip_paren(e)
{
    let value = lower_style_object(obj, scope)?;
    return Ok(Some(JsxAttr { name: final_name, value }));
}
```
3. Add `lower_style_object` (build pieces; decide Static vs Concat), `css_kebab` (camelCase
   → kebab; leading-cap vendor `Webkit`→`-webkit`, `Moz`→`-moz`, `ms`→`-ms`, `O`→`-o`;
   pass through `--custom`/already-kebab), and `UNITLESS: &[&str]` (the 40-entry React 19
   `isUnitlessNumber` set from the spec; compare against the ORIGINAL camelCase key).
   For a string-literal value, embed verbatim; numeric literal → `n` then `px` unless
   unitless; member-path (`Member`/`Ident` via `lower_expr`) → a `StaticText(":"-joined
   prefix)` + the path `Expr`. If all pieces are static text → join → `AttrValue::Static`;
   else → `AttrValue::Expr(Expr::Concat(pieces))` where literal CSS runs are `StaticText`.
   Reject computed/shorthand/spread props → `StyleObjectNotSupported`; non-literal /
   non-member-path values → `StyleObjectValueNotSupported`.

> Edge (spec Tests): a literal value containing `"` (`content: '\\"\\"'`) must round-trip —
> `emit_expr_path`'s `Concat` arm backslash-escapes `"` inside the jinja string literal
> (`emit_jinja.rs:245`). Add a unit test for the Concat case; for the all-`Static` case the
> value sits in `style="…"` and is `push_attr_escaped` (`"` → `&quot;`).

### 2c — golden fixture + 2d verify/commit

`fixtures/style_object.tsx` with a static and a dynamic style. `UPDATE_GOLDEN=1`, eyeball,
FIXTURES += "style_object". Verify commands. Commit: `feat(compiler): support style={{…}} object attrs with auto-px (S1)`.

**BLOCKED fallback:** if `SwcExpr::Object` property AST shapes differ from expectation
(swc 25 `Prop::KeyValue` / `PropName::{Ident,Str,Num,Computed}`), enumerate the real
variants from `swc_core::ecma::ast::Prop` and map: `KeyValue` accepted, `Shorthand`/
`Getter`/`Setter`/`Method`/`Assign` → `StyleObjectNotSupported`, `Computed` key →
`StyleObjectNotSupported`.

---

## Task 3 — S8: dynamic `<BrustPage>` head props

**Files:** `src/ir.rs` (new `HeadValue` enum + `Document` field types), `src/lower.rs`
(`lower_brust_page` + lang default + tests), `src/emit_jinja.rs` (Document arm + tests),
`fixtures/brust_page_dynamic.tsx` + `.expected.jinja` (+ render test), FIXTURES += "brust_page_dynamic".

### 3a — RED: tests

`src/lower.rs`:
```rust
// <BrustPage title={d.title}> → Document.title == Some(HeadValue::Path(MemberAccess|Field))
// <BrustPage title="x">       → Some(HeadValue::Literal("x"))
// omitted lang                → Some(HeadValue::Literal("en"))
// <BrustPage title={fn()}>    → BrustPageAttrMustBeStringLiteral
```
`src/emit_jinja.rs`:
```rust
// Document{ title: Path(Field("t")) }    → contains "<title>{{ t }}</title>"
// Document{ lang: Path(Field("l")) }     → contains "lang=\"{{ l }}\""
// Document{ title: Literal("Hi") }       → "<title>Hi</title>"   (unchanged)
```

### 3b — GREEN

1. `src/ir.rs`: add
```rust
#[derive(Debug, Clone)]
pub enum HeadValue { Literal(String), Path(Expr) }
```
   Change `JsxNode::Document` fields `lang/html_class/body_class/title/description` from
   `Option<String>` to `Option<HeadValue>`. Update the `cond_node_clones`/doc comments as
   needed; fix the ir.rs doc comment that says fields are "string-literal PROPS".
2. `src/lower.rs` `lower_brust_page` (`:627-707`): change the local `Option<String>` vars to
   `Option<HeadValue>`; the value match becomes:
```rust
match &jsx_attr.value {
    Some(JSXAttrValue::Str(s)) =>
        *slot = Some(HeadValue::Literal(s.value.to_string_lossy().into_owned())),
    Some(JSXAttrValue::JSXExprContainer(c)) => {
        if let JSXExpr::Expr(e) = &c.expr {
            match lower_expr(e, scope)? {
                ex @ (crate::ir::Expr::Field(_) | crate::ir::Expr::MemberAccess { .. }) =>
                    *slot = Some(HeadValue::Path(ex)),
                _ => return Err(LowerError::at(jsx_attr.span,
                        ErrorKind::BrustPageAttrMustBeStringLiteral(name))),
            }
        } else {
            return Err(LowerError::at(jsx_attr.span,
                ErrorKind::BrustPageAttrMustBeStringLiteral(name)));
        }
    }
    _ => return Err(LowerError::at(jsx_attr.span,
            ErrorKind::BrustPageAttrMustBeStringLiteral(name))),
}
```
   lang default (`:677`): `lang = Some(HeadValue::Literal("en".to_string()))`.
   (Broaden the `BrustPageAttrMustBeStringLiteral` thiserror message to "...must be a string
   literal or member-path" in lib.rs.)
3. `src/emit_jinja.rs` Document arm (`:72-118`): replace each `if let Some(x) = field { …
   push_*_escaped(out, x) }` with a `HeadValue` match. Add a small helper:
```rust
fn emit_head_attr(out: &mut String, name: &str, hv: &HeadValue) {
    let _ = write!(out, " {name}=\"");
    match hv {
        HeadValue::Literal(s) => push_attr_escaped(out, s),
        HeadValue::Path(e) => { let _ = write!(out, "{{{{ {} }}}}", emit_expr_path(e)); }
    }
    out.push('"');
}
```
   Use it for `lang`/`class`(html)/`class`(body). For `<title>`:
   `Literal` → `push_html_escaped`; `Path` → `{{ emit_expr_path }}`. Same for the
   description `content="…"` (attr position → `emit_head_attr`-style).

### 3c — golden + 3d verify/commit

`fixtures/brust_page_dynamic.tsx`: `<BrustPage title={d.title} description={d.desc} lang={d.lang}>`.
`UPDATE_GOLDEN=1`, eyeball, FIXTURES += "brust_page_dynamic". Add a render test in
`golden_render_jinja/main.rs` passing `context!{ d_title => "Charizard · PokéDex", … }`
(NB: context keys are the dotted path's segments — `title` interpolates `{{ title }}`; with
`title={d.title}` the path is `d.title`, so the context needs a nested `d` object — mirror
the existing `props_hello` render test's context shape). Verify. Commit:
`feat(compiler): dynamic <BrustPage> head props via member-path (S8)`.

**BLOCKED fallback:** if changing `Document` to `Option<HeadValue>` ripples into the React
factory emitter (`emit_factory.rs`) — check whether `Document` is matched there. If it is and
only reads literals, add a `HeadValue::Literal(s) => s` extraction at that call site (the
React/native-shell path only ever sees compile-time literals there); if `Path` reaches it,
that's a genuine new case — surface via advisor rather than silently stringifying.

---

## Task 4 — Acceptance: dogfood the PokéDex

**Files:** `example/pokedex/pages/*.tsx`, `example/pokedex/lib/loaders.ts` (remove
workaround fields). TS gate: `bun run ci` (biome — memory `brust-ts-ci-gates-biome-not-cargo`).

1. Replace the hide-class workarounds with real conditionals:
   pagination `{flags.hasPrev ? <a/> : <span/>}`, detail `{d.notFound ? <NotFound/> : <Content/>}`,
   evolution separators with `{i > 0 && <Arrow/>}`. Remove `prevClass`/`nextClass`/
   `contentClass`/`notFoundClass`/`sepClassName`/`levelClassName` from the loaders where now
   dead.
2. Replace `style={heroStyle}` / `style={st.barWidth}` string-in-loader with
   `style={{ background: d.heroBg }}` / `style={{ width: st.barWidthPct }}` where it reads
   cleaner (keep loader-computed where the value is genuinely a precomputed gradient string).
3. Dynamic title: `<BrustPage title={d.pageTitle}>` (loader sets `pageTitle`).
4. Build + run (memory: native routes REQUIRE `brust build` first):
```bash
cd /Users/detoro/code/brust
bun run runtime/cli/index.ts build example/pokedex/index.ts
BRUST_PORT=7788 bun run example/pokedex/index.ts   # then browser-verify
```
5. Browser smoke (Playwright headless per handoff — chrome-in-claude not connected): list,
   detail (`/pokemon/charizard`), type-chart render; pagination disabled state; `/pokemon/zzz`
   shows 404 block; `<title>` is per-page. Capture a screenshot.
6. `bun run ci` clean. Commit: `example(pokedex): use native conditionals/style/title (drop workarounds)`.

**BLOCKED fallback (memory `build-jinja-dual-emit-stale-brust`):** if a native route 500s
"template not registered" after edits, the `.brust/jinja` mirror is stale — re-run
`brust build` and boot on a FRESH port (island chunk cache `max-age=3600`, memory
`native-island-integration-flake`). If a converted page won't compile, capture the exact
compiler error and narrow which construct the spec under-specified before pivoting.

---

## Notes for the orchestrator

- Tasks 1→2→3 are sequential (Task 3 mutates `ir.rs`/`emit_jinja.rs`; Tasks 1-2 only touch
  `lower.rs`/`lib.rs` — but run sequentially regardless, per pipeline rule).
- Each task: implementer subagent → spec-compliance review (read the diff) → code-quality
  review (`ecc:rust-reviewer`) → fix findings → next task.
- After all 4: Phase 6 re-runs the three verify commands + the dogfood smoke independently.
- Assert NO `| e` / autoescape was added (spec Escaping contract — verbatim is intentional).
