# M1b-1 — IR types, expression/JSX readers, hook extraction, `brustc --emit ir` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a parsed component into a structural `ComponentIR` (spec §5): state/derived/effects/handlers/refs from the hook calls, and a template `Node` tree with every expression captured as a brust-owned `RawExpr` — printed as JSON by `brustc --emit ir` and frozen by golden fixtures. Placement, jobs, children tiers and the tier decision are M1b-2; this plan ends with every IR field that does not need them.

**Architecture:** `crates/brust-compiler/src/ir/` is pure Rust + serde and never names `bun_ast`. `analyze/expr.rs` converts Bun's visited expression nodes into `RawExpr` (identifiers resolved to Local / Import / Global through the symbol table). `analyze/jsx.rs` reads the **lowered** JSX calls (`jsx(tag, props, key?)`, `was_jsx_element: true`) back into `Node`s. `analyze/hooks.rs` reads the component body's top-level statements. `analyze/component.rs` ties them together into `ComponentIR` with `tier: Pending` and `Expr::Raw` placements. M1a hardening items F1/F2 are Task 1 because every later task sits on them.

**Tech Stack:** Rust nightly-2026-09-15, Bun crates at rev 620b50f6 (already linked), serde/serde_json, golden fixtures runner from M1a.

**Spec:** `docs/design/2026-10-08-react-compiler-design.md` §4.2(b) (readers only), §4.3, §5 (IR), §6.2 (the grammar `RawExpr` must be able to carry), §9; `docs/plans/m1a-followups.md` F1, F2, F6.

## Global Constraints

- `ir/` and `lower/` compile without `bun_ast` in scope (spec §9 rule); only `parse/` and `analyze/` import Bun crates.
- Parse with `opts.jsx.development = false` so JSX lowers to `jsx`/`jsxs(tag, props[, key])` (3 args max), never the 6-arg `jsxDEV`.
- React Compiler stays disabled in the parser; HIR only via `analyze_fn` (M1a).
- `RawExpr` must represent every production of the §6.2 grammar losslessly, plus an `Opaque` escape for everything else, so M1b-2 can decide placement without re-reading the AST.
- Every `RawExpr` and `Node` carries `loc: u32` (byte offset of its start) so diagnostics can quote a line.
- Golden fixtures are the contract: `BRUSTC_UPDATE=1` rewrites, the diff is reviewed.
- Commit trailer per the implementer's harness.

## Review Focus

1. **Deeply nested JSX or expressions** (6000-deep `<div>`) must either compile or return `HirError::Unsupported`/a diagnostic — never SIGABRT the process (F1). Task 1 pins it.
2. **JSX text with entities and whitespace** (`&nbsp;`, `{' '}`, multi-line text with indentation) must round-trip the way React renders it (JSX whitespace rules), not raw source bytes — Task 4 pins it with a fixture.
3. **`useState` destructuring variants** (`const [a] = useState(0)`, `const [, setB] = useState(1)`, `const s = useState(0)` without destructuring) must each produce a correct `StateDecl` or a precise Fallback reason, never a panic — Task 5 pins it.
4. **An identifier shadowing a hook or a prop** (`const useState = …` locally, a param named `window`) must be classified by its symbol, not its name — Task 3 pins it (`Ident` kinds come from the symbol table / import records, never from the spelling).
5. **Spread props on an element** (`<div {...rest}>`) and `children` passed explicitly as a prop must produce a `RawExpr::Opaque` attribute / an `Unsupported` diagnostic, not silently drop the attribute — Task 4 pins it.

---

## File structure

```
crates/brust-compiler/src/
├─ lib.rs                      + pub mod ir; pub mod analyze::{expr, jsx, hooks, component}
├─ parse/mod.rs                F1 (big-stack worker), F2 (with_ast accessor), jsx.development=false
├─ ir/
│  ├─ mod.rs                   pub use; ComponentIR, Tier, Diagnostic
│  ├─ expr.rs                  RawExpr, IdentKind, BinOp, UnOp, Literal, Expr (placement enum with Raw)
│  ├─ template.rs              Node, Attr, EventAttr, ForNode, Binding
│  ├─ decls.rs                 PropDecl, StateDecl, DerivedDecl, EffectDecl, HandlerDecl, RefDecl, JobDecl, ChildLink, CacheDecl
│  └─ tests.rs                 serde round-trip
├─ analyze/
│  ├─ mod.rs                   pub mod hir; pub mod expr; pub mod jsx; pub mod hooks; pub mod component;
│  ├─ names.rs                 NameTable: Ref -> (name, IdentKind) from symbols + import records + globals
│  ├─ expr.rs                  read_expr(&Expr, &NameTable) -> RawExpr
│  ├─ jsx.rs                   read_jsx(&Expr, …) -> Node
│  ├─ hooks.rs                 read_body(&G::Fn, …) -> BodyDecls
│  └─ component.rs             analyze_component(&Parsed) -> Result<ComponentIR, Diagnostic>
├─ summary.rs                  drop `identifiers` (F6)
crates/brust-compiler-cli/src/main.rs   + --emit ir | diag
tests/fixtures/<case>/expected.ir.json  (+ new cases)
```

Frozen interfaces for M1b-2 / M1c (names and shapes; fields may grow but not change meaning):

```rust
// ir/expr.rs
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum IdentKind { Prop, Local, State, Setter, Import { source: String, imported: String }, Global, LoopBinding, Unknown }
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Literal { Str(String), Num(f64), Bool(bool), Null, Undefined }
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp { Add, Sub, Mul, Div, Rem, Eq, Ne, StrictEq, StrictNe, Lt, Le, Gt, Ge, And, Or, Nullish }
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp { Not, Neg, Pos, Typeof }
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RawExpr { pub loc: u32, pub kind: RawKind }
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum RawKind {
    Lit(Literal),
    Ident { name: String, kind: IdentKind },
    Member { target: Box<RawExpr>, name: String, optional: bool },
    Index { target: Box<RawExpr>, index: Box<RawExpr> },
    Call { callee: Box<RawExpr>, args: Vec<RawExpr> },           // callee is Ident or Member
    Binary { op: BinOp, left: Box<RawExpr>, right: Box<RawExpr> },
    Unary { op: UnOp, value: Box<RawExpr> },
    Cond { test: Box<RawExpr>, yes: Box<RawExpr>, no: Box<RawExpr> },
    Template { head: String, parts: Vec<(RawExpr, String)> },
    Array(Vec<RawExpr>),
    Object(Vec<(String, RawExpr)>),
    Arrow { params: Vec<String>, body: ArrowBody, captures: Vec<(String, IdentKind)> },
    Jsx(Box<crate::ir::template::Node>),                          // JSX in expression position (map bodies, ternary arms)
    Opaque { source: String, why: String },                       // anything else; `source` is the printed JS
}
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum ArrowBody { Expr(Box<RawExpr>), Block { source: String, captures_only: bool } }
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Expr { Raw(RawExpr), Server(ServerExpr), Precomputed { slot: String, js: String, inputs: Vec<String> }, ClientOnly { js: String } }
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ServerExpr(pub RawExpr);   // M1b-2 narrows: a RawExpr proven inside the §6.2 grammar

// ir/template.rs
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Node {
    Element { loc: u32, tag: String, attrs: Vec<Attr>, children: Vec<Node>, host: bool, ref_name: Option<String> },
    Text(String),
    Slot(Expr),
    If { cond: Expr, then: Vec<Node>, else_: Vec<Node> },
    For { source: Expr, item: String, index: Option<String>, key: Expr, body: Vec<Node> },
    Component { loc: u32, name: String, source: Option<String>, props: Vec<(String, Expr)>, children: Vec<Node>, link: Option<u32> },
    Fragment(Vec<Node>),
}
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Attr { Static { name: String, value: String }, Dynamic { name: String, value: Expr }, Event { event: String, handler: String }, Ref { name: String }, Spread(Expr) }

// ir/decls.rs
pub struct PropDecl { pub name: String, pub ts_type: Option<String> }
pub struct StateDecl { pub name: String, pub setter: Option<String>, pub init: Expr }
pub struct DerivedDecl { pub name: String, pub expr: Expr }
pub struct EffectDecl { pub body: RawExpr /* Arrow */, pub deps: Option<Vec<RawExpr>>, pub layout: bool }
pub struct HandlerDecl { pub name: String /* _hN */, pub body: RawExpr /* Arrow or Ident */, pub item_scoped: Vec<String> }
pub struct RefDecl { pub name: String, pub init: Expr }
pub struct JobDecl { pub kind: JobKind, pub inputs: Vec<String>, pub outputs: Vec<String> }   // M1b-2 fills
pub struct ChildLink { pub id: u32, pub child: String, pub props_member: String, pub item_scoped: Vec<String> }  // M1b-2 fills
pub struct CacheDecl { pub key: Option<RawExpr>, pub tags: Option<RawExpr>, pub revalidate: Option<f64> }         // M1b-2 fills

// ir/mod.rs
pub enum Tier { Pending, Static, Native, React { reason: String, client_only: bool } }
pub struct Diagnostic { pub class: DiagClass /* Fallback | Error | Warning */, pub rule: String, pub message: String, pub loc: u32, pub line: u32, pub col: u32, pub remediation: String }
pub struct ComponentIR { id, source, tier, props, state, derived, effects, handlers, refs, template: Node, jobs, child_links, client_props, client_imports, needs_worker, cache, diagnostics }
```

---

### Task 1: Hardening — F1 big-stack worker, F2 accessor, `jsx.development=false`, F6

**Files:**
- Modify: `crates/brust-compiler/src/parse/mod.rs`, `src/analyze/hir.rs`, `src/summary.rs`, `src/lib.rs`
- Test: `crates/brust-compiler/tests/hardening.rs`; fixtures `tests/fixtures/deep-nesting/input.tsx` (generated by the test, not committed) ; update `expected.hir.json` goldens (drop `identifiers`)

**Interfaces:**
- Produces: `pub fn run_on_compiler_thread<T: Send>(f: impl FnOnce() -> T + Send) -> T` in `parse/mod.rs` — runs `f` on a thread with a 256 MiB stack and Bun's stack-limit initialised for that thread; every public entry (`parse_tsx`, `analyze_hir`, later `analyze_component`) is **documented as requiring** to be called inside it, and `brustc` wraps its whole run in it. `Parsed::with_ast(|ast: &Ast<'_>| …)` replaces `ast()`.

- [ ] **Step 1: Failing tests**

`crates/brust-compiler/tests/hardening.rs`:

```rust
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};
use brust_compiler::analyze::hir::analyze_hir;

fn deep(n: usize) -> Vec<u8> {
    let mut s = String::from("export default function Deep() { return ");
    for _ in 0..n { s.push_str("<div>"); }
    s.push('x');
    for _ in 0..n { s.push_str("</div>"); }
    s.push_str(" }\n");
    s.into_bytes()
}

#[test]
fn six_thousand_deep_jsx_does_not_abort() {
    let r = run_on_compiler_thread(|| {
        let parsed = parse_tsx("deep.tsx", deep(6000))?;
        analyze_hir(&parsed).map(|s| s.function).map_err(|e| e.to_string())
    }.map_err(|e: brust_compiler::parse::ParseError| e.to_string()));
    // Either outcome is acceptable; a process abort is not.
    match r { Ok(name) => assert_eq!(name, "Deep"), Err(msg) => assert!(!msg.is_empty()) }
}

#[test]
fn with_ast_borrow_does_not_outlive_parsed() {
    run_on_compiler_thread(|| {
        let parsed = parse_tsx("a.tsx", b"export default function A() { return <p/> }".to_vec()).unwrap();
        let n = parsed.with_ast(|ast| ast.symbols.len());
        assert!(n > 0);
    });
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p brust-compiler --test hardening 2>&1 | tail -5`
Expected: `run_on_compiler_thread` / `with_ast` unresolved.

- [ ] **Step 3: Implement**

In `parse/mod.rs`:

```rust
/// Every compiler entry point must run inside this: Bun's parser and the vendored React
/// Compiler recurse without a stack guard (m1a-followups F1). 256 MiB covers ~6000-deep JSX.
pub fn run_on_compiler_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    const STACK: usize = 256 << 20;
    std::thread::Builder::new()
        .name("brust-compiler".into())
        .stack_size(STACK)
        .spawn(move || {
            #[cfg(feature = "bun-stubs")]
            stubs::native::set_stack_size(STACK - (1 << 20));
            f()
        })
        .expect("spawn compiler thread")
        .join()
        .unwrap_or_else(|e| std::panic::resume_unwind(e))
}
```

Keep the per-thread stack-limit logic Dew added in M1a (it computes from pthread bounds); `set_stack_size` here only needs to be whatever that helper requires on a fresh thread — reuse it. Replace `pub(crate) fn ast(&self) -> &js_ast::Ast<'static>` with:

```rust
    pub(crate) fn with_ast<R>(&self, f: impl FnOnce(&js_ast::Ast<'_>) -> R) -> R { f(&self.ast) }
```

and update `analyze/hir.rs` to use it (the `AstHost` holds `&'a js_ast::Ast<'a>` inside the closure). Set `opts.jsx.development = false;` in `parse_tsx`. In `summary.rs` remove `identifiers`; in `analyze/hir.rs` stop filling it. Then `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures` and review the golden diff (only the `identifiers` line disappears). `brustc` `main()` wraps everything after arg parsing in `run_on_compiler_thread`.

If the 6000-deep test still aborts at 256 MiB, add an iterative depth pre-check in `parse_tsx` (count unmatched `<` tags while scanning bytes; above 4096 return `ParseError { message: "JSX nesting deeper than 4096 is not supported" }`) and keep the big-stack thread for the realistic range.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p brust-compiler 2>&1 | grep -E "^test result|FAILED"` and `cargo test -p brust-compiler-cli`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates tests/fixtures
git commit -m "fix(compiler): big-stack compiler thread, with_ast accessor, jsx dev off, drop identifiers from HirSummary"
```

---

### Task 2: IR types + serde

**Files:**
- Create: `src/ir/mod.rs`, `src/ir/expr.rs`, `src/ir/template.rs`, `src/ir/decls.rs`, `src/ir/tests.rs`
- Modify: `src/lib.rs` (`pub mod ir;`)

**Interfaces:**
- Produces: every type in the frozen block above, all `#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]`, `Default` for `ComponentIR` and `Diagnostic`-free fields; `ComponentIR::new(id, source)`; `Diagnostic::{fallback, error, warning}(rule, message, loc, remediation)` constructors that leave `line/col` 0 for the component layer to fill from the source (helper `fn line_col(source: &[u8], loc: u32) -> (u32, u32)` in `ir/mod.rs`).

- [ ] **Step 1: Failing test**

`src/ir/tests.rs` (declared with `#[cfg(test)] mod tests;` in `ir/mod.rs`):

```rust
use super::*;
use super::expr::*;
use super::template::*;

#[test]
fn component_ir_round_trips_through_json() {
    let mut ir = ComponentIR::new("themeToggle_1a2b3c4d".into(), "components/ThemeToggle.tsx".into());
    ir.state.push(decls::StateDecl { name: "mode".into(), setter: Some("setMode".into()), init: Expr::Raw(RawExpr { loc: 10, kind: RawKind::Lit(Literal::Str("dark".into())) }) });
    ir.template = Node::Element { loc: 0, tag: "button".into(), attrs: vec![Attr::Event { event: "click".into(), handler: "_h1".into() }], children: vec![Node::Slot(Expr::Raw(RawExpr { loc: 5, kind: RawKind::Ident { name: "label".into(), kind: IdentKind::Local } }))], host: true, ref_name: None };
    ir.diagnostics.push(Diagnostic::warning("fragment-root", "wrapped", 0, "return one element"));
    let json = serde_json::to_string_pretty(&ir).unwrap();
    let back: ComponentIR = serde_json::from_str(&json).unwrap();
    assert_eq!(back, ir);
    assert!(json.contains("\"tier\": \"Pending\""));
}

#[test]
fn line_col_is_one_based() {
    assert_eq!(line_col(b"ab\ncd", 0), (1, 1));
    assert_eq!(line_col(b"ab\ncd", 3), (2, 1));
    assert_eq!(line_col(b"ab\ncd", 4), (2, 2));
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p brust-compiler ir::` → unresolved module.

- [ ] **Step 3: Implement** the types exactly as the frozen block, with `serde(tag = "kind")`-free plain enum representation (externally tagged — the default — so JSON reads `{"Ident": {...}}`), `Tier` and `DiagClass` as unit/struct variants, and:

```rust
// ir/mod.rs
pub mod decls; pub mod expr; pub mod template;
#[cfg(test)] mod tests;
pub use decls::*; pub use expr::*; pub use template::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Tier { Pending, Static, Native, React { reason: String, client_only: bool } }
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagClass { Fallback, Error, Warning }
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Diagnostic { pub class: DiagClass, pub rule: String, pub message: String, pub loc: u32, pub line: u32, pub col: u32, pub remediation: String }
impl Diagnostic {
    pub fn fallback(rule: &str, message: impl Into<String>, loc: u32, remediation: &str) -> Self { Self { class: DiagClass::Fallback, rule: rule.into(), message: message.into(), loc, line: 0, col: 0, remediation: remediation.into() } }
    pub fn error(rule: &str, message: impl Into<String>, loc: u32, remediation: &str) -> Self { Self { class: DiagClass::Error, ..Self::fallback(rule, message, loc, remediation) } }
    pub fn warning(rule: &str, message: impl Into<String>, loc: u32, remediation: &str) -> Self { Self { class: DiagClass::Warning, ..Self::fallback(rule, message, loc, remediation) } }
}
pub fn line_col(source: &[u8], loc: u32) -> (u32, u32) {
    let (mut line, mut col) = (1u32, 1u32);
    for &b in &source[..(loc as usize).min(source.len())] { if b == b'\n' { line += 1; col = 1 } else { col += 1 } }
    (line, col)
}
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ComponentIR {
    pub id: String, pub source: String, pub tier: Tier,
    pub props: Vec<PropDecl>, pub state: Vec<StateDecl>, pub derived: Vec<DerivedDecl>, pub effects: Vec<EffectDecl>,
    pub handlers: Vec<HandlerDecl>, pub refs: Vec<RefDecl>, pub template: Node, pub jobs: Vec<JobDecl>, pub child_links: Vec<ChildLink>,
    pub client_props: Vec<String>, pub client_imports: Vec<String>, pub needs_worker: bool, pub cache: Option<CacheDecl>, pub diagnostics: Vec<Diagnostic>,
}
impl ComponentIR { pub fn new(id: String, source: String) -> Self { Self { id, source, tier: Tier::Pending, props: vec![], state: vec![], derived: vec![], effects: vec![], handlers: vec![], refs: vec![], template: Node::Fragment(vec![]), jobs: vec![], child_links: vec![], client_props: vec![], client_imports: vec![], needs_worker: false, cache: None, diagnostics: vec![] } } }
```

`ComponentId` rule (spec §5): `camelCase(file stem) + "_" + first 8 hex of blake3/sha? ` — use `sha256` is a new dependency; instead use `std::hash::DefaultHasher` over the path → 8 hex. Put `pub fn component_id(path: &str) -> String` in `ir/mod.rs` with a test: `component_id("components/ThemeToggle.tsx")` starts with `themeToggle_` and is 8 hex after the underscore and stable across runs (DefaultHasher is seeded per-process in newer std — use `std::hash::SipHasher13::new_with_keys(0,0)` via the `siphasher` crate? No: use a tiny FNV-1a implemented inline, 64-bit, deterministic).

- [ ] **Step 4: Run to verify pass** — `cargo test -p brust-compiler ir::`

- [ ] **Step 5: Commit** — `git commit -m "feat(ir): ComponentIR, RawExpr, Node/Attr and decl types with serde"`

---

### Task 3: Name table + expression reader

**Files:**
- Create: `src/analyze/names.rs`, `src/analyze/expr.rs`; modify `src/analyze/mod.rs`
- Test: `crates/brust-compiler/tests/expr_reader.rs`

**Interfaces:**
- Produces:
  - `pub struct NameTable<'a>` built once per component from `Parsed` (`NameTable::new(ast, source, component_fn)`): `fn kind_of(&self, r: Ref) -> (String, IdentKind)` using: the component's parameter bindings → `Prop` (destructured names) ; `const [a, setA] = useState(...)` declarations (filled by Task 5 via `mark_state(name_ref)`, `mark_setter`) ; `ast.named_imports` → `Import { source: import_records[idx].path, imported: alias }` ; symbols that are `unbound` (the parser marks globals: check `Symbol.kind == SymbolKind::Unbound`, read the enum in `src/ast/symbol.rs`) → `Global` ; everything else → `Local`.
  - `pub fn read_expr(e: &Expr, names: &NameTable, src: &[u8], printer: &dyn Fn(&Expr) -> String) -> RawExpr` — total function; unknown shapes become `Opaque { source: printer(e), why }`.
  - `pub fn print_expr_js(parsed: &Parsed, e: &Expr) -> String` in `analyze/expr.rs` using `bun_js_printer`'s single-expression entry (the `pub fn` just above `pub fn print` in `vendor`-free `bun_js_printer` `lib.rs` ~line 7925 that calls `printer.print_expr(expr, Level::Lowest, ExprFlagSet::empty())`; confirm its exact name and signature in the checkout and record it in a comment).

- [ ] **Step 1: Failing tests**

`tests/expr_reader.rs` — compile tiny components and inspect the `RawExpr` of the single JSX slot via a test-only helper `read_first_slot(src) -> RawExpr` that Task 4 will also use (implement it in `analyze/component.rs` as `pub fn debug_first_slot(parsed) -> Option<RawExpr>` behind `#[doc(hidden)]`):

```rust
use brust_compiler::ir::expr::*;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};
use brust_compiler::analyze::component::debug_first_slot;

fn slot(body: &str) -> RawExpr {
    let src = format!("import {{ fmt }} from './money'\nimport {{ useState }} from 'react'\nexport default function C({{ a, b }}: any) {{ const [n, setN] = useState(1); const x = a + 1; return <p>{{{body}}}</p> }}\n");
    run_on_compiler_thread(move || {
        let parsed = parse_tsx("C.tsx", src.into_bytes()).unwrap();
        debug_first_slot(&parsed).expect("slot")
    })
}
fn ident(e: &RawExpr) -> (&str, &IdentKind) { match &e.kind { RawKind::Ident { name, kind } => (name, kind), k => panic!("{k:?}") } }

#[test] fn prop_local_state_import_global_kinds() {
    assert_eq!(ident(&slot("a")), ("a", &IdentKind::Prop));
    assert_eq!(ident(&slot("x")), ("x", &IdentKind::Local));
    assert_eq!(ident(&slot("n")), ("n", &IdentKind::State));
    assert_eq!(ident(&slot("setN")), ("setN", &IdentKind::Setter));
    assert_eq!(ident(&slot("fmt")), ("fmt", &IdentKind::Import { source: "./money".into(), imported: "fmt".into() }));
    assert_eq!(ident(&slot("window")), ("window", &IdentKind::Global));
}
#[test] fn member_binary_cond_template() {
    match slot("a.b.c").kind { RawKind::Member { name, .. } => assert_eq!(name, "c"), k => panic!("{k:?}") }
    match slot("a === 1 ? 'x' : b").kind { RawKind::Cond { test, .. } => matches!(test.kind, RawKind::Binary { op: BinOp::StrictEq, .. }), k => panic!("{k:?}") };
    match slot("`hi ${a}!`").kind { RawKind::Template { head, parts } => { assert_eq!(head, "hi "); assert_eq!(parts[0].1, "!") }, k => panic!("{k:?}") }
}
#[test] fn calls_and_opaque() {
    match slot("fmt(a.price)").kind { RawKind::Call { callee, args } => { assert!(matches!(callee.kind, RawKind::Ident { .. })); assert_eq!(args.len(), 1) }, k => panic!("{k:?}") }
    match slot("a.map(i => i.n)").kind { RawKind::Call { callee, args } => { assert!(matches!(callee.kind, RawKind::Member { .. })); assert!(matches!(args[0].kind, RawKind::Arrow { .. })) }, k => panic!("{k:?}") }
    match slot("new Date(a)").kind { RawKind::Opaque { source, why } => { assert!(source.contains("Date")); assert!(!why.is_empty()) }, k => panic!("{k:?}") }
}
#[test] fn shadowed_hook_name_is_local_not_import() {
    let src = "export default function C() { const useState = (v: number) => [v, () => {}]; const [n] = useState(1); return <p>{n}</p> }\n";
    let e = run_on_compiler_thread(move || { let p = parse_tsx("S.tsx", src.as_bytes().to_vec()).unwrap(); debug_first_slot(&p).unwrap() });
    assert_eq!(ident(&e), ("n", &IdentKind::Local)); // not State: useState here is a local, not the react import
}
#[test] fn arrow_captures() {
    match slot("() => setN(n + a)").kind { RawKind::Arrow { params, captures, .. } => { assert!(params.is_empty()); let names: Vec<_> = captures.iter().map(|c| c.0.as_str()).collect(); assert!(names.contains(&"setN") && names.contains(&"n") && names.contains(&"a")) }, k => panic!("{k:?}") }
}
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

`names.rs`: build from `ast.symbols` (index = `Ref::inner_index`), `ast.named_imports` (keys are the local `Ref`s; `alias` = imported name; `import_record_index` → `ast.import_records[i].path.text`), the component function's `args[0]` binding (`B::Object` properties → names with their `Ref`s → `Prop`; a plain identifier param → mark `props_ident` so `props.x` members are also `Prop` reads), and state/setter sets added by Task 5 before reading the JSX. Globals: a symbol with no declaring scope — read `Symbol` fields (`kind`, `link`) in `src/ast/symbol.rs` and the parser's unbound handling (`SymbolKind::Unbound`) to decide; the test `window` → `Global` is the contract.

`expr.rs`: `read_expr` matches on `e.data`:
- `EString` → `Lit(Str)` (`slice8()` when UTF-8, else decode `slice16()`); `ENumber` → `Lit(Num)`; `EBoolean`, `ENull`, `EUndefined`.
- `EIdentifier{ref_}` / `EImportIdentifier{ref_}` → `Ident` via `names.kind_of`.
- `EDot{target,name,optional_chain}` → `Member`; `EIndex{target,index}` → `Index`.
- `ECall{target,args}` where target is Ident/Member → `Call`; otherwise `Opaque`.
- `EBinary{op,left,right}` with `OpCode` in the `BinOp` table → `Binary`; other ops (`BinPow`, bitwise, `BinIn`, `BinInstanceof`, `BinComma`) → `Opaque{why:"operator"}`.
- `EUnary{op,value}`: `UnNot/UnNeg/UnPos/UnTypeof` → `Unary`; others → `Opaque`.
- `EIf{test,yes,no}` → `Cond`.
- `ETemplate{tag:None,head,parts}` → `Template` (tagged templates → `Opaque`).
- `EArray{items}` → `Array` (a spread item → `Opaque`); `EObject{properties}` with `PropertyKind::Normal` and string/identifier keys → `Object`; spread/computed → `Opaque`.
- `EArrow{args,body}` → `Arrow`: params = simple identifier bindings (`B::Identifier`) names; `body`: if `prefer_expr` and the block is a single `return expr` → `ArrowBody::Expr(read_expr(expr))`, else `ArrowBody::Block{source: printer(e)}`; `captures` = every `EIdentifier`/`EImportIdentifier` referenced inside the body whose `Ref` is not one of the arrow's own params/locals, resolved through `names` (walk the body statements/expressions recursively with a small visitor over `Data`; do not use the React Compiler for this).
- `ECall{was_jsx_element: true}` → `Jsx(read_jsx(...))` (Task 4 provides `read_jsx`; until then return `Opaque{why:"jsx"}` and Task 4 swaps it).
- everything else → `Opaque{source: printer(e), why: <variant name>}`.

The single-expression printer: find it in `bun_js_printer` (`grep -n "print_expr(" lib.rs` near line 7925 shows a `pub fn` wrapper); `print_expr_js` builds a `BufferPrinter` like M1a's `--emit parse` path and calls it with the `Parsed`'s arena/source/symbols. If no such public wrapper exists, fall back to slicing the source text: `Expr.loc.start` to the next expression's start is not reliable — instead add `pub fn print_expression(...)` to the **vendored** crate? No: `bun_js_printer` is a git dep, not vendored. Then the fallback is: wrap the expression in a one-statement `Ast` is also heavy. Decision if the wrapper is missing: `Opaque.source` = source bytes from `loc.start` to the end of the enclosing JSX attribute/child (the JSX reader knows the next sibling's `loc`), trimmed. Record which path was taken in a note; the test only asserts `source.contains("Date")`.

- [ ] **Step 4: Run to verify pass** — `cargo test -p brust-compiler --test expr_reader`

- [ ] **Step 5: Commit** — `git commit -m "feat(analyze): NameTable and RawExpr reader over Bun's visited AST"`

---

### Task 4: JSX reader

**Files:**
- Create: `src/analyze/jsx.rs`; modify `src/analyze/expr.rs` (swap the `Jsx` arm), `src/analyze/component.rs` (`debug_first_slot` uses it)
- Test: `crates/brust-compiler/tests/jsx_reader.rs`, fixtures `tests/fixtures/jsx-shapes/input.tsx` with `expected.ir.json` (Task 6 wires the golden; here the unit test asserts the `Node`)

**Interfaces:**
- Produces: `pub fn read_jsx(call: &Expr, names: &NameTable, …) -> Node` for a lowered JSX call; `pub fn read_children(children_prop: Option<&Expr>, …) -> Vec<Node>` handling: `EString` text (JSX whitespace rules already applied by the parser — verify with the fixture), nested JSX calls, `cond && <x/>` → `If{then}`, `cond ? <a/> : <b/>` → `If{then,else_}` (arms that are not JSX become `Slot`), `expr.map(arrow)` with a JSX arrow body → `For{source, item, index, key, body}` where `key` is the `key` argument of the body's JSX call (missing key → `Diagnostic::error("list-key", …)` recorded via a `&mut Vec<Diagnostic>` parameter), `{expr}` → `Slot(Expr::Raw)`, `{' '}` → `Text(" ")`, `null/false/undefined` children → dropped.
- Attributes: string literal → `Static` (`className` kept as React spelling; M1c maps names), `onXxx={…}` → `Event{event: "xxx" lowercased, handler}` where the handler expression is recorded in `ir.handlers` by Task 5's hoisting (`_hN`) — the JSX reader emits `Event{handler: "<pending:N>"}` with a side table of `(N, RawExpr)` so Task 5 names them; `ref={r}` → `Attr::Ref{name}` (and marks `Element.ref_name`); `key=` on a non-list element → warning; spread → `Attr::Spread(Expr::Raw(Opaque))` + warning; `dangerouslySetInnerHTML` → `Diagnostic::error("no-innerhtml", …)` (spec: `x-html` deliberately absent).
- Components: tag is an `Ident` with `Import{source,imported}` or `Local` kind → `Node::Component{name, source, props, children}`; member tags (`<Ctx.Provider>`) → `Diagnostic::fallback("member-tag", …)` and `Node::Component{name:"<member>", source:None}`; fragments (tag resolved to the `Fragment` jsx import) → `Fragment`.
- Host rule (spec §5.2): the component's root — if the returned node is one `Element` it gets `host: true`; a `Fragment` root is wrapped by Task 6 in `Element{tag:"brust-host", host:true}` with a `Warning("fragment-root")`.

- [ ] **Step 1: Failing tests**

`tests/jsx_reader.rs`:

```rust
use brust_compiler::ir::template::*;
use brust_compiler::ir::expr::*;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};
use brust_compiler::analyze::component::debug_template;   // (Parsed) -> (Node, Vec<Diagnostic>)

fn tpl(src: &str) -> (Node, Vec<brust_compiler::ir::Diagnostic>) {
    let s = src.to_string();
    run_on_compiler_thread(move || { let p = parse_tsx("T.tsx", s.into_bytes()).unwrap(); debug_template(&p) })
}

#[test] fn element_attrs_text_and_slot() {
    let (n, d) = tpl("export default function T({ name }: any) { return <a href=\"/docs\" className={`x ${name}`} data-n={3} aria-label=\"d\">Hi, {name}!</a> }");
    assert!(d.is_empty());
    let Node::Element { tag, attrs, children, host, .. } = n else { panic!("{n:?}") };
    assert_eq!(tag, "a"); assert!(host);
    assert!(matches!(&attrs[0], Attr::Static { name, value } if name == "href" && value == "/docs"));
    assert!(matches!(&attrs[1], Attr::Dynamic { name, .. } if name == "className"));
    assert_eq!(children.len(), 3);
    assert!(matches!(&children[0], Node::Text(t) if t == "Hi, "));
    assert!(matches!(&children[1], Node::Slot(_)));
    assert!(matches!(&children[2], Node::Text(t) if t == "!"));
}
#[test] fn whitespace_rules_and_entities() {
    let (n, _) = tpl("export default function T() { return <p>\n    a&nbsp;b{' '}\n    <b>c</b>\n  </p> }");
    let Node::Element { children, .. } = n else { panic!() };
    assert!(matches!(&children[0], Node::Text(t) if t == "a\u{a0}b"));
    assert!(matches!(&children[1], Node::Text(t) if t == " "));
    assert!(matches!(&children[2], Node::Element { tag, .. } if tag == "b"));
    assert_eq!(children.len(), 3);
}
#[test] fn conditionals_lists_and_keys() {
    let (n, d) = tpl("export default function T({ items, show }: any) { return <ul>{show && <li>s</li>}{show ? <li>a</li> : <li>b</li>}{items.map((it: any, i: number) => <li key={it.id}>{it.name}</li>)}</ul> }");
    assert!(d.is_empty(), "{d:?}");
    let Node::Element { children, .. } = n else { panic!() };
    assert!(matches!(&children[0], Node::If { else_, .. } if else_.is_empty()));
    assert!(matches!(&children[1], Node::If { else_, .. } if !else_.is_empty()));
    let Node::For { item, index, key, body, .. } = &children[2] else { panic!("{:?}", children[2]) };
    assert_eq!(item, "it"); assert_eq!(index.as_deref(), Some("i"));
    assert!(matches!(key, Expr::Raw(RawExpr { kind: RawKind::Member { name, .. }, .. }) if name == "id"));
    assert!(matches!(&body[0], Node::Element { tag, .. } if tag == "li"));
}
#[test] fn missing_key_is_an_error() {
    let (_, d) = tpl("export default function T({ items }: any) { return <ul>{items.map((it: any) => <li>{it}</li>)}</ul> }");
    assert!(d.iter().any(|x| x.rule == "list-key" && matches!(x.class, brust_compiler::ir::DiagClass::Error)));
}
#[test] fn components_fragments_events_refs_spread() {
    let (n, d) = tpl("import Child from './Child'\nimport { useRef } from 'react'\nexport default function T({ rest }: any) { const r = useRef(null); return <><Child n={1} onPick={() => 0}>x</Child><input ref={r} onChange={(e: any) => 0} {...rest} /></> }");
    let Node::Fragment(kids) = n else { panic!("{n:?}") };
    assert!(matches!(&kids[0], Node::Component { name, source, props, children, .. } if name == "Child" && source.as_deref() == Some("./Child") && props.len() == 2 && children.len() == 1));
    let Node::Element { attrs, ref_name, .. } = &kids[1] else { panic!() };
    assert_eq!(ref_name.as_deref(), Some("r"));
    assert!(attrs.iter().any(|a| matches!(a, Attr::Event { event, .. } if event == "change")));
    assert!(attrs.iter().any(|a| matches!(a, Attr::Spread(_))));
    assert!(d.iter().any(|x| x.rule == "spread-props"));
}
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement** `jsx.rs` per the interface. Reading a lowered call: `args[0]` = tag (`EString` → intrinsic; `EIdentifier/EImportIdentifier` → component or Fragment by `names`), `args[1]` = `EObject` props (each `G::Property{key: Some(EString), value: Some(expr)}`; `children` key → `read_children`; `PropertyKind::Spread` → `Attr::Spread`), `args.get(2)` = key expr (only meaningful inside a `.map` body). `jsxs` vs `jsx` is irrelevant. Text children: the parser already applied JSX whitespace collapsing and entity decoding when it produced the `EString` — the `whitespace_rules_and_entities` test checks that; if Bun kept raw text, implement React's rule (trim lines, drop whitespace-only lines containing a newline, join with single spaces) in `jsx.rs`.

- [ ] **Step 4: Run to verify pass** — `cargo test -p brust-compiler --test jsx_reader --test expr_reader`

- [ ] **Step 5: Commit** — `git commit -m "feat(analyze): JSX reader — elements, text, conditionals, keyed lists, components, events, refs"`

---

### Task 5: Hooks and body reader

**Files:**
- Create: `src/analyze/hooks.rs`; modify `names.rs` (state/setter marks), `component.rs`
- Test: `crates/brust-compiler/tests/hooks_reader.rs`

**Interfaces:**
- Produces: `pub struct BodyDecls { props: Vec<PropDecl>, state: Vec<StateDecl>, derived: Vec<DerivedDecl>, effects: Vec<EffectDecl>, handlers: Vec<HandlerDecl>, refs: Vec<RefDecl>, uses_id: bool, return_expr: Option<Expr>, diagnostics: Vec<Diagnostic>, react_reason: Option<String> }` and `pub fn read_body(func: &G::Fn, names: &mut NameTable, …) -> BodyDecls`.
- Rules (spec §4.3): walk `func.body.stmts` top-level in order:
  - `S::Local{decls}` with value `ECall` whose callee is `Ident{Import{source:"react", imported:"useState"}}` (or `React.useState` member of the react default/namespace import): binding `B::Array[a, b?]` → `StateDecl{name:a, setter:b, init: Raw(args[0] or Undefined)}`; a `B::Identifier` binding (`const s = useState()`) → `react_reason = "useState result used without destructuring"`.
  - `useMemo(fn, deps)` → `DerivedDecl{expr: Raw(Arrow body expr)}` when the arrow body is an expression, else `react_reason`; `useCallback(fn, deps)` → `HandlerDecl` named after the binding (not `_hN`); `useRef(init)` → `RefDecl`; `useId()` → `uses_id = true`; `useEffect`/`useLayoutEffect(fn, deps?)` as an `S::Expr` statement → `EffectDecl{body: Raw(Arrow), deps: Option<Vec<RawExpr>>, layout}`.
  - any other `use*`-named call (import from react or local) → `react_reason = "hook <name> is not supported"`; a hook call not at top level (inside `if`/loop) → `react_reason` (the HIR already errors; mirror it).
  - `S::Local` with a non-hook value → `DerivedDecl{name, expr: Raw}` (every local const; M1b-2 decides which are derived-from-state, which are precompute, which are server constants). `let`/`var` → `react_reason = "let/var in component body"`.
  - `S::Function` / nested function declarations → treated like a `const` with an `Arrow` value.
  - `S::Return{value}` → `return_expr = Raw(read_expr)` (expected `Jsx`); any statement after the return is ignored; `if`/`for`/`while`/`try` at top level → `react_reason = "control flow before return"`.
  - Handler hoisting: after reading the template, every `Attr::Event{handler:"<pending:N>"}` gets `_h{N}` and a `HandlerDecl{name:"_hN", body}`; an event whose expression is an `Ident{Local}` naming a `DerivedDecl`/`useCallback` handler keeps that name (no hoist). `item_scoped` = the loop bindings in scope at that attribute (passed down by the JSX reader as a `Vec<String>` scope).
  - Props: `args[0]` binding `B::Object` → `PropDecl` per property (ts type text from the parser's TS metadata if cheaply available, else `None`); plain identifier param → one `PropDecl{name:"props"}` and member reads `props.x` are `Prop` idents named `x` (the NameTable handles that).

- [ ] **Step 1: Failing tests**

`tests/hooks_reader.rs`:

```rust
use brust_compiler::ir::*;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};
use brust_compiler::analyze::component::analyze_component;

fn ir(src: &str) -> ComponentIR { let s = src.to_string(); run_on_compiler_thread(move || { let p = parse_tsx("H.tsx", s.into_bytes()).unwrap(); analyze_component(&p).unwrap() }) }
const PRE: &str = "import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect, useId } from 'react'\n";

#[test] fn theme_toggle_decls() {
    let ir = ir(&format!("{PRE}export default function ThemeToggle({{ themeLabel }}: any) {{ const [mode, setMode] = useState('dark'); const label = mode === 'dark' ? 'Light' : 'Dark'; useEffect(() => {{ document.documentElement.dataset.mode = mode }}, [mode]); return <button aria-label={{themeLabel}} onClick={{() => setMode((m: string) => m === 'dark' ? 'light' : 'dark')}}>{{label}}</button> }}"));
    assert_eq!(ir.props.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["themeLabel"]);
    assert_eq!(ir.state.len(), 1); assert_eq!(ir.state[0].name, "mode"); assert_eq!(ir.state[0].setter.as_deref(), Some("setMode"));
    assert_eq!(ir.derived.len(), 1); assert_eq!(ir.derived[0].name, "label");
    assert_eq!(ir.effects.len(), 1); assert!(!ir.effects[0].layout); assert_eq!(ir.effects[0].deps.as_ref().map(|d| d.len()), Some(1));
    assert_eq!(ir.handlers.len(), 1); assert_eq!(ir.handlers[0].name, "_h1");
    let Node::Element { attrs, .. } = &ir.template else { panic!() };
    assert!(attrs.iter().any(|a| matches!(a, Attr::Event { event, handler } if event == "click" && handler == "_h1")));
    assert!(matches!(ir.tier, Tier::Pending));
}
#[test] fn state_destructuring_variants() {
    let a = ir(&format!("{PRE}export default function A() {{ const [n] = useState(0); const [, setM] = useState(1); return <p>{{n}}</p> }}"));
    assert_eq!(a.state.len(), 2); assert_eq!(a.state[0].setter, None); assert_eq!(a.state[1].name, ""); assert_eq!(a.state[1].setter.as_deref(), Some("setM"));
    let b = ir(&format!("{PRE}export default function B() {{ const s = useState(0); return <p>{{s[0]}}</p> }}"));
    assert!(b.diagnostics.iter().any(|d| d.rule == "hook-shape"));
}
#[test] fn memo_callback_ref_id_layout() {
    let ir = ir(&format!("{PRE}export default function M({{ a }}: any) {{ const r = useRef(null); const id = useId(); const dbl = useMemo(() => a * 2, [a]); const go = useCallback(() => 1, []); useLayoutEffect(() => {{}}); return <div ref={{r}} id={{id}} onClick={{go}}>{{dbl}}</div> }}"));
    assert_eq!(ir.refs.len(), 1); assert_eq!(ir.derived.iter().find(|d| d.name == "dbl").is_some(), true);
    assert!(ir.handlers.iter().any(|h| h.name == "go")); assert!(ir.effects[0].layout);
    let Node::Element { attrs, ref_name, .. } = &ir.template else { panic!() };
    assert_eq!(ref_name.as_deref(), Some("r"));
    assert!(attrs.iter().any(|a| matches!(a, Attr::Event { handler, .. } if handler == "go")));
}
#[test] fn unsupported_hook_and_control_flow_record_react_reason() {
    let a = ir("import { useContext } from 'react'\nconst C = null as any\nexport default function U() { const t = useContext(C); return <p>{t}</p> }");
    assert!(a.diagnostics.iter().any(|d| d.rule == "hook-unsupported" && d.message.contains("useContext")));
    let b = ir(&format!("{PRE}export default function V({{ x }}: any) {{ if (x) {{ return <p/> }} return <i/> }}"));
    assert!(b.diagnostics.iter().any(|d| d.rule == "control-flow"));
}
#[test] fn item_scoped_handler_records_bindings() {
    let ir = ir(&format!("{PRE}export default function L({{ items }}: any) {{ const pick = (i: any) => i; return <ul>{{items.map((it: any) => <li key={{it.id}} onClick={{() => pick(it)}}>{{it.n}}</li>)}}</ul> }}"));
    let h = ir.handlers.iter().find(|h| h.name == "_h1").unwrap();
    assert_eq!(h.item_scoped, vec!["it".to_string()]);
}
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement** `hooks.rs` and `component.rs` (`analyze_component` = find the default-export function (reuse M1a logic; arrow default export → `Diagnostic::fallback("default-export-shape")` + tier stays Pending), build `NameTable`, `read_body`, then `read_jsx` on `return_expr`, hoist handlers, apply the host rule, fill `ir.diagnostics` line/col via `line_col`, set `id = component_id(path)`). `debug_first_slot` / `debug_template` are thin wrappers.

- [ ] **Step 4: Run to verify pass** — all three reader test files plus `cargo test -p brust-compiler`.

- [ ] **Step 5: Commit** — `git commit -m "feat(analyze): hooks/body reader and analyze_component producing structural ComponentIR"`

---

### Task 6: `brustc --emit ir | diag` and golden fixtures

**Files:**
- Modify: `crates/brust-compiler-cli/src/main.rs`, `crates/brust-compiler/tests/fixtures.rs` (add `ir` and `diag` emits; F5: on update, delete the other-kind expectation)
- Create fixtures: `tests/fixtures/{product-card,parent-counter,keyed-list,controlled-input,react-child,client-only,server-leak,missing-key,fragment-root,jsx-shapes}/input.tsx` with the components named in the spec (§6.4 `ProductCard`, §7.4 `Parent`/`Counter` — put `Counter` in `tests/fixtures/parent-counter/Counter.tsx`, keyed list with per-item handler, controlled input `value={q} onChange={e => setQ(e.target.value)}`, a `useContext` child, a `window.innerWidth` read, a `import { db } from 'node:fs'` captured by a handler, a list without key, a fragment root). Only `input.tsx` is compiled; sibling component files are resolved in M1b-2.

- [ ] **Step 1: CLI**

Add `"ir"` (pretty JSON of `analyze_component`) and `"diag"` (one line per diagnostic: `<class> <rule> <file>:<line>:<col> <message> — <remediation>`; exit 1 if any `Error`) arms; keep `parse`/`hir`.

- [ ] **Step 2: Fixtures runner**

For each case: write `expected.ir.json` and `expected.diag.txt` (empty file when no diagnostics) in addition to `expected.hir.json`; `BRUSTC_UPDATE=1` removes `expected.error.txt` when a case now succeeds and vice versa (F5).

- [ ] **Step 3: Generate, review, commit**

```bash
BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures
git diff --stat; git add tests/fixtures crates
git commit -m "feat(brustc): --emit ir|diag with golden fixtures for the M1b-1 reader set"
```

Review every `expected.ir.json` by eye against the spec's examples before committing; the parent-counter and product-card goldens are what M1b-2 and M1c build on.

---

## Self-review notes

- **Spec coverage (M1b-1 slice):** §5 types → Task 2; §4.2(b) "reads" (JSX/expr/hooks) → Tasks 3–5; §4.3 hook table → Task 5; §6.2 grammar carried losslessly by `RawExpr` → Task 3 (`BinOp`/`UnOp`/`Template`/`Member`/`Call`/`Cond`/`Array`/`Object` cover every production; `Array.from`/`Object.keys` are `Call`s); §5.2 host rule → Task 4/5; F1/F2/F5/F6 → Tasks 1 and 6. Deferred to M1b-2 by design: placement, jobs/precompute inputs, capture → `client_props`/`client_imports`/server-only, children tiers and `ChildLink`, `cache()`, `needs_worker`, the tier decision.
- **Type consistency:** `RawExpr/RawKind/IdentKind/Expr/Node/Attr`, `NameTable`, `read_expr/read_jsx/read_body/analyze_component`, `debug_first_slot/debug_template`, `run_on_compiler_thread/with_ast` are named identically across tasks.
- **Review Focus → tests:** 1 → Task 1; 2 → Task 4 `whitespace_rules_and_entities`; 3 → Task 5 `state_destructuring_variants`; 4 → Task 3 `shadowed_hook_name_is_local_not_import`; 5 → Task 4 `components_fragments_events_refs_spread`.
- **Known soft spots (implementer judgment, note them):** the single-expression printer entry name in `bun_js_printer`; how Bun represents JSX text (pre-collapsed or raw); `Symbol` field that marks unbound globals; TS type text for `PropDecl.ts_type` (may stay `None` in M1b-1).

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m1b1-ir-readers` | 1–6 | complex | Implementer (Complex) | — (M1a merged) | complex | `cargo test -p brust-compiler` and `-p brust-compiler-cli` all green (paste per-file counts incl. hardening, expr_reader, jsx_reader, hooks_reader, fixtures); `cargo clippy … --no-deps -D warnings` and `cargo fmt --check` clean; `brustc tests/fixtures/theme-toggle/input.tsx --emit ir` output pasted; PR `lane/m1b1-ir-readers -> v2` with CI green; lane HEAD sha. |

Gate commands: `cargo fmt --all -- --check`, `cargo clippy -p brust-compiler -p brust-compiler-cli --no-deps -- -D warnings`, `cargo test --workspace --exclude bun_react_compiler`.
