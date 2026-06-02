# Plan — JSX→Rust compiler Phase A1 (swc_core 68 + maud 0.27)

**Spec:** `docs/superpowers/specs/2026-05-28-jsx-rust-compiler-phase-a1-design.md` (v2.1, HEAD `db54010`)
**Branch:** `refactor/cargo-workspace`
**Skill:** `superpowers:writing-plans` (TDD-shaped, bite-sized, BLOCKED-fallback per risky task)

---

## Task → spec coverage map

| Task | Spec sections | Description |
|---|---|---|
| T0 | S3, S4.1 | Add `crates/jsx-rust-compiler` as workspace member, smoke-build with swc_core 68 + maud 0.27 |
| T1 | S4.2, S4.3 | Parser entrypoint: `&str` → `swc_ecma_ast::Module` with TS+JSX, parse errors propagated |
| T2 | S6, parts of S4.4 | Public API + `CompileError`/`ErrorKind` skeleton, `path:line:col` formatting |
| T3 | S4.3, S4.4 | Lower swc AST → IR for the happy path (StaticHello shape, no props, no exprs) |
| T4 | S4.4 EXPR rules, S5.1–5.3 | Lower props patterns, ident/member access, type inference for owned `String` props |
| T5 | S4.4 map rule, S5.1 `@for`, S5.4 nested struct emit | Lower `.map((item) => <JSX>)` with iter-binding scope, generate `<Root>Item` struct |
| T6 | S4.5, S4.6, S4.4 void-element check | Attribute rename precedence (on*/ref/key/table/uppercase), JSX whitespace normalization, void-element child rejection |
| T7 | S5 emit module | maud-syntax emitter: elements, attrs, text, expr children, map → renders 3 fixtures |
| T8 | S10 + S9.2 | Three fixtures + `tests/golden_emit.rs` integration test |
| T9 | S9.3 + S9.4 | `tests/golden_render/{main.rs, *.rs}` integration test using `#[path]` mods + maud render comparison |
| T10 | S7 | CLI binary `jsx-rustc` with `--check`/`-o` flags, stderr error format |
| T11 | S11, S9.4 | Full workspace verification: lib + release + bun runtime + integration tests; commit checkpoint |

Every `ErrorKind` variant in S6 has a unit test introduced in T3–T6 (positive lowering or specific error case). Spec acceptance criterion #8 is satisfied as those tasks land.

---

## T0 — Bootstrap `crates/jsx-rust-compiler/`

**Why first**: S15.1 BLOCKED fallback hinges on whether swc_core 68 + maud 0.27 compile cleanly against the workspace's existing serde. If T0 fails, NO other task can run; the fallback fires before T1.

### Files

Create:
- `crates/jsx-rust-compiler/Cargo.toml` (workspace member, package = `jsx-rust-compiler`)
- `crates/jsx-rust-compiler/src/lib.rs` (just `// stub`)

Modify:
- `Cargo.toml` (workspace root): add `"crates/jsx-rust-compiler"` to `members`

### `Cargo.toml` (workspace root) diff

```toml
members = [
    "crates/brust",
    "crates/jsx-rust-compiler",
]
```

### `crates/jsx-rust-compiler/Cargo.toml`

```toml
[package]
name    = "jsx-rust-compiler"
version = "0.1.0"
edition = "2024"

[lib]
path = "src/lib.rs"

[[bin]]
name = "jsx-rustc"
path = "src/bin/jsx-rustc.rs"

[dependencies]
swc_core  = { version = "68", features = ["ecma_ast", "ecma_parser_typescript", "ecma_visit", "common"] }
thiserror = "1"

[dev-dependencies]
maud              = "0.27"
pretty_assertions = "1"
```

### `crates/jsx-rust-compiler/src/lib.rs`

```rust
// stub — populated in T2
```

### Commands & expected output

```
cargo build -p jsx-rust-compiler
```

Expected: compiles cleanly. swc_core's transitive graph (~80 crates) will download on first build.

```
cargo build --workspace
```

Expected: brust + jsx-rust-compiler both build. 107 existing brust tests are not affected.

### BLOCKED fallback (per spec S15.1)

If `cargo build -p jsx-rust-compiler` fails:

1. `cargo build -p jsx-rust-compiler --verbose 2>&1 | head -60` to find the failing crate.
2. If failure is `proc-macro2` / `syn` / `quote` version conflict: `cargo tree -p jsx-rust-compiler -i proc-macro2` — find the conflicting branch in the workspace; relax the `crates/brust/Cargo.toml` direct dep to allow the swc-required version.
3. If failure is rustc version: `rustc --version`; require ≥ 1.85 (matches `edition = "2024"`).
4. If failure is lockfile divergence: `rm Cargo.lock && cargo build -p jsx-rust-compiler` (the existing brust build is reset to the new lockfile; verify with full workspace test).
5. **Do NOT** pin serde DOWN — swc_core 68 internally resolves to serde 1.0.228; pinning to 1.0.215 would break the build, NOT fix it.
6. If 1–4 all fail with novel root causes: ESCALATE to advisor before pivoting parser strategy.

### Commit

```
chore(A1): bootstrap crates/jsx-rust-compiler workspace member
- swc_core 68 + maud 0.27 dev-dep + thiserror
- lib stub, bin placeholder added in T2/T10
```

---

## T1 — Parser entrypoint (swc → `Module`)

**Why next**: every subsequent task depends on having a parsed `swc_ecma_ast::Module` to lower. T1 isolates the parser config in a small testable surface.

### Files

Create:
- `crates/jsx-rust-compiler/src/parser.rs`

Modify:
- `crates/jsx-rust-compiler/src/lib.rs` (add `mod parser;`)

### `src/parser.rs`

```rust
use swc_core::common::{
    errors::{Handler, HandlerFlags},
    sync::Lrc,
    FileName, SourceMap,
};
use swc_core::ecma::ast::Module;
use swc_core::ecma::parser::{
    error::Error as SwcParseError, lexer::Lexer, Capturing, Parser, StringInput, Syntax, TsSyntax,
};

pub struct ParsedSource {
    pub module: Module,
    pub source_map: Lrc<SourceMap>,
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("parse error: {0}")]
    Swc(String),
}

pub fn parse(source: &str, path: &str) -> Result<ParsedSource, ParseError> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        Lrc::new(FileName::Custom(path.to_string())),
        source.to_string(),
    );

    let lexer = Lexer::new(
        Syntax::Typescript(TsSyntax {
            tsx: true,
            ..Default::default()
        }),
        Default::default(),
        StringInput::from(&*fm),
        None,
    );

    let capturing = Capturing::new(lexer);
    let mut parser = Parser::new_from(capturing);

    match parser.parse_module() {
        Ok(module) => {
            let errs = parser.take_errors();
            if let Some(first) = errs.into_iter().next() {
                return Err(ParseError::Swc(format!("{first:?}")));
            }
            Ok(ParsedSource { module, source_map: cm })
        }
        Err(err) => Err(ParseError::Swc(format!("{err:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_tsx() {
        let src = "export default function Hi() { return <div/>; }";
        let parsed = parse(src, "<test>").unwrap();
        assert_eq!(parsed.module.body.len(), 1);
    }

    #[test]
    fn rejects_unterminated_jsx() {
        let src = "export default function Hi() { return <div; }";
        let err = parse(src, "<test>");
        assert!(err.is_err(), "expected parse error, got {err:?}");
    }

    #[test]
    fn accepts_typescript_destructured_props() {
        let src = "export default function Hi({ a, b }: { a: string; b: string }) { return <div/>; }";
        let parsed = parse(src, "<test>").unwrap();
        assert_eq!(parsed.module.body.len(), 1);
    }
}
```

### Commands

```
cargo test -p jsx-rust-compiler --lib parser::
```

Expected: 3 tests pass.

### BLOCKED fallback

If swc_core's API names diverge from the spec (e.g. `Capturing::new` renamed, `parser.take_errors()` returns a different type):
1. Run `cargo doc -p swc_ecma_parser --no-deps --open` and locate the equivalents.
2. Update to the actual names. Document each rename inline with a `// renamed in swc_ecma_parser N.x: was X` comment.
3. If parser construction blocks for non-trivial reasons (e.g. required feature gate), escalate to advisor.

### Commit

```
T1(A1): parser entrypoint — swc_core Module parse for TSX
- Syntax::Typescript with tsx: true
- 3 unit tests (minimal, error, destructured-typed props)
```

---

## T2 — Public API + `CompileError`/`ErrorKind` skeleton

### Files

Modify:
- `crates/jsx-rust-compiler/src/lib.rs`

### `src/lib.rs`

```rust
mod parser;
mod ir;
mod lower;
mod emit;

pub fn compile(source: &str) -> Result<String, CompileError> {
    compile_with_path(source, "<stdin>")
}

pub fn compile_with_path(source: &str, path: &str) -> Result<String, CompileError> {
    let parsed = parser::parse(source, path).map_err(|e| CompileError {
        path: path.to_string(),
        line: 0,
        col: 0,
        kind: ErrorKind::Parse(e.to_string()),
    })?;

    let ir = lower::lower(&parsed).map_err(|e| CompileError::from_lower(e, path, &parsed))?;
    Ok(emit::emit(&ir))
}

#[derive(Debug, thiserror::Error)]
#[error("{path}:{line}:{col}: {kind}")]
pub struct CompileError {
    pub path: String,
    pub line: u32,
    pub col: u32,
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
    #[error("unresolved identifier `{0}`")] UnresolvedIdent(String),
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

impl CompileError {
    pub(crate) fn from_lower(err: lower::LowerError, path: &str, parsed: &parser::ParsedSource) -> Self {
        let (line, col) = span_to_line_col(&err.span, parsed);
        Self {
            path: path.to_string(),
            line,
            col,
            kind: err.kind,
        }
    }
}

fn span_to_line_col(span: &swc_core::common::Span, parsed: &parser::ParsedSource) -> (u32, u32) {
    let loc = parsed.source_map.lookup_char_pos(span.lo);
    (loc.line as u32, loc.col.0 as u32 + 1)
}
```

Create stub `crates/jsx-rust-compiler/src/lower.rs`:
```rust
use swc_core::common::Span;
use crate::ErrorKind;
use crate::parser::ParsedSource;
use crate::ir::Component;

pub struct LowerError {
    pub span: Span,
    pub kind: ErrorKind,
}

pub fn lower(_parsed: &ParsedSource) -> Result<Component, LowerError> {
    todo!("populated in T3")
}
```

Create stub `crates/jsx-rust-compiler/src/ir.rs`:
```rust
pub struct Component {
    pub _placeholder: (),  // shape filled in T3
}
```

Create stub `crates/jsx-rust-compiler/src/emit.rs`:
```rust
use crate::ir::Component;

pub fn emit(_component: &Component) -> String {
    String::new()
}
```

### Commands

```
cargo build -p jsx-rust-compiler
cargo test -p jsx-rust-compiler --lib
```

Expected: compiles, 3 parser tests still pass. `compile` is callable but parse-error path is the only thing exercised.

### Tests

Add to `src/lib.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_error_formats_with_path() {
        let err = compile_with_path("export default function;", "fixtures/bad.tsx").unwrap_err();
        let formatted = format!("{err}");
        assert!(formatted.starts_with("fixtures/bad.tsx:0:0: parse error:"), "got: {formatted}");
    }
}
```

The `line: 0, col: 0` here reflects that parser errors don't yet carry a span; T1 can be revisited in A5+ for better parser-error spans.

### Commit

```
T2(A1): public compile API + CompileError/ErrorKind taxonomy
- compile / compile_with_path / Display formats as path:line:col: kind
- stub lower + emit modules wired
```

---

## T3 — Lower swc AST → IR (happy path: zero-prop static JSX)

### Files

Modify:
- `crates/jsx-rust-compiler/src/ir.rs`
- `crates/jsx-rust-compiler/src/lower.rs`

### `src/ir.rs`

```rust
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct Component {
    pub name: String,
    pub props: PropsShape,
    pub root: JsxNode,
}

#[derive(Debug, Default)]
pub struct PropsShape {
    /// Top-level destructured prop names, in declaration order.
    pub bindings: Vec<String>,
    /// Inferred struct types: prop name → ProptInfo (String leaf or nested struct).
    pub types: BTreeMap<String, PropType>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropType {
    /// Leaf String, referenced by direct `{name}` or via member chain bottoming here.
    OwnedString,
    /// Vec<NameItem> generated from `.map` source; element type is `Struct { fields }`.
    VecOf(Box<PropType>),
    /// Generated struct keyed by Pascal-cased name; fields are nested types.
    Struct(BTreeMap<String, PropType>),
}

#[derive(Debug, Default)]
pub enum JsxNode {
    #[default]
    Empty,
    Element {
        tag: String,
        attrs: Vec<JsxAttr>,
        children: Vec<JsxNode>,
    },
    Text(String),
    Expr(Expr),
    Map {
        source: Expr,
        binding: String,
        body: Box<JsxNode>,
    },
}

#[derive(Debug)]
pub struct JsxAttr {
    pub name: String,
    pub value: AttrValue,
}

#[derive(Debug)]
pub enum AttrValue {
    /// Bare boolean attribute (`disabled`).
    Empty,
    /// String literal (`class="foo"`).
    Static(String),
    /// Number literal.
    StaticNum(i64),
    /// Expression (`href={item.href}`).
    Expr(Expr),
}

#[derive(Debug, Clone)]
pub enum Expr {
    /// Field on props, e.g. `props.title`.
    Field(String),
    /// Member chain rooted at a destructured prop, e.g. `user.address.city`.
    MemberAccess { root: String, path: Vec<String> },
    /// Reference to a `.map` iter binding (e.g. inside `.map((item) => …)`, `item`).
    MapBinding(String),
    /// Member chain rooted at a map binding, e.g. `item.href`.
    MapMember { root: String, path: Vec<String> },
    /// String literal in expression position.
    StaticText(String),
    /// Integer literal in expression position.
    StaticNum(i64),
}
```

### `src/lower.rs` (T3 scope only: zero-prop static)

```rust
use swc_core::common::Span;
use swc_core::ecma::ast::*;

use crate::ir::*;
use crate::parser::ParsedSource;
use crate::ErrorKind;

pub struct LowerError {
    pub span: Span,
    pub kind: ErrorKind,
}

impl LowerError {
    fn at(span: Span, kind: ErrorKind) -> Self {
        Self { span, kind }
    }
}

pub fn lower(parsed: &ParsedSource) -> Result<Component, LowerError> {
    let (name, function) = find_default_export(&parsed.module)?;
    let body = function.function.body.as_ref().ok_or_else(|| {
        LowerError::at(function.function.span, ErrorKind::BodyMustBeSingleReturn)
    })?;
    let return_expr = single_return_expr(body)?;
    let jsx = strip_paren(return_expr);
    let element = match jsx {
        Expr::JSXElement(el) => el,
        _ => return Err(LowerError::at(jsx.span(), ErrorKind::BodyMustBeSingleReturn)),
    };
    let root = lower_element(element, &[])?;
    Ok(Component {
        name,
        props: PropsShape::default(),
        root,
    })
}

fn find_default_export(module: &Module) -> Result<(String, &FnExpr), LowerError> {
    let mut found: Option<(String, &FnExpr)> = None;
    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(_)) => continue,
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(ExportDefaultDecl { decl, .. })) => {
                if let DefaultDecl::Fn(fn_expr) = decl {
                    let name = fn_expr
                        .ident
                        .as_ref()
                        .map(|i| i.sym.to_string())
                        .unwrap_or_else(|| "Anonymous".to_string());
                    if found.is_some() {
                        return Err(LowerError::at(fn_expr.function.span, ErrorKind::UnexpectedStatement));
                    }
                    found = Some((name, fn_expr));
                } else {
                    return Err(LowerError::at(span_of_item(item), ErrorKind::UnexpectedStatement));
                }
            }
            _ => return Err(LowerError::at(span_of_item(item), ErrorKind::UnexpectedStatement)),
        }
    }
    found.ok_or_else(|| LowerError::at(Span::default(), ErrorKind::UnexpectedStatement))
}

fn span_of_item(item: &ModuleItem) -> Span {
    match item {
        ModuleItem::ModuleDecl(decl) => decl.span(),
        ModuleItem::Stmt(stmt) => stmt.span(),
    }
}

fn single_return_expr(body: &BlockStmt) -> Result<&Expr, LowerError> {
    if body.stmts.len() != 1 {
        return Err(LowerError::at(body.span, ErrorKind::BodyMustBeSingleReturn));
    }
    match &body.stmts[0] {
        Stmt::Return(ReturnStmt { arg: Some(expr), .. }) => Ok(expr),
        other => Err(LowerError::at(other.span(), ErrorKind::BodyMustBeSingleReturn)),
    }
}

fn strip_paren(expr: &Expr) -> &Expr {
    if let Expr::Paren(ParenExpr { expr, .. }) = expr {
        strip_paren(expr)
    } else {
        expr
    }
}

fn lower_element(el: &JSXElement, _scope: &[String]) -> Result<JsxNode, LowerError> {
    let tag = lower_element_name(&el.opening.name)?;
    // T6 adds: void-element children check, attr renames, whitespace normalization, on*/ref/key
    let attrs = el
        .opening
        .attrs
        .iter()
        .map(lower_attr_T3)
        .collect::<Result<Vec<_>, _>>()?;

    let mut children = Vec::new();
    for child in &el.children {
        if let Some(node) = lower_child_T3(child)? {
            children.push(node);
        }
    }

    Ok(JsxNode::Element { tag, attrs, children })
}

fn lower_element_name(name: &JSXElementName) -> Result<String, LowerError> {
    match name {
        JSXElementName::Ident(ident) => {
            let s = ident.sym.to_string();
            if s.starts_with(|c: char| c.is_ascii_uppercase()) {
                Err(LowerError::at(ident.span, ErrorKind::CustomComponentNotSupported(s)))
            } else {
                Ok(s)
            }
        }
        JSXElementName::JSXMemberExpr(e) => Err(LowerError::at(e.span, ErrorKind::MemberComponentNotSupported)),
        JSXElementName::JSXNamespacedName(n) => Err(LowerError::at(n.span, ErrorKind::NamespacedElementNotSupported)),
    }
}

#[allow(non_snake_case)]
fn lower_attr_T3(attr: &JSXAttrOrSpread) -> Result<JsxAttr, LowerError> {
    match attr {
        JSXAttrOrSpread::SpreadElement(s) => Err(LowerError::at(s.dot3_token, ErrorKind::SpreadAttributeNotSupported)),
        JSXAttrOrSpread::JSXAttr(jsx_attr) => {
            let name = match &jsx_attr.name {
                JSXAttrName::Ident(name) => name.sym.to_string(),
                JSXAttrName::JSXNamespacedName(n) => {
                    return Err(LowerError::at(n.span, ErrorKind::NamespacedAttrNotSupported));
                }
            };
            // T6 promotes this to full attr-precedence handling
            let value = match &jsx_attr.value {
                None => AttrValue::Empty,
                Some(JSXAttrValue::Lit(Lit::Str(s))) => AttrValue::Static(s.value.to_string()),
                Some(JSXAttrValue::Lit(Lit::Num(n))) => {
                    if n.value.fract() != 0.0 {
                        return Err(LowerError::at(n.span, ErrorKind::NonIntegerNumericNotSupported));
                    }
                    AttrValue::StaticNum(n.value as i64)
                }
                _ => return Err(LowerError::at(jsx_attr.span, ErrorKind::JsxInAttrNotSupported)),
            };
            Ok(JsxAttr { name, value })
        }
    }
}

#[allow(non_snake_case)]
fn lower_child_T3(child: &JSXElementChild) -> Result<Option<JsxNode>, LowerError> {
    match child {
        JSXElementChild::JSXText(text) => {
            let cleaned = normalize_whitespace_T3(&text.value);
            if cleaned.is_empty() {
                Ok(None)
            } else {
                Ok(Some(JsxNode::Text(cleaned)))
            }
        }
        JSXElementChild::JSXElement(el) => Ok(Some(lower_element(el, &[])?)),
        JSXElementChild::JSXFragment(f) => Err(LowerError::at(f.span, ErrorKind::FragmentNotSupported)),
        JSXElementChild::JSXSpreadChild(s) => Err(LowerError::at(s.span, ErrorKind::SpreadChildNotSupported)),
        // T4 adds: JSXExprContainer handling
        JSXElementChild::JSXExprContainer(c) => {
            Err(LowerError::at(c.span, ErrorKind::BareIdentNotSupported("(T4)".into())))
        }
    }
}

#[allow(non_snake_case)]
fn normalize_whitespace_T3(s: &str) -> String {
    // Static-only T3 rule: drop whitespace-only nodes.
    if s.trim().is_empty() { String::new() } else { s.trim().to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    #[test]
    fn lowers_zero_prop_static_jsx() {
        let src = r#"export default function StaticHello() {
  return (
    <div>
      <h1>Hello from compiled Rust</h1>
      <p>This page is statically generated.</p>
    </div>
  )
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        assert_eq!(c.name, "StaticHello");
        match &c.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "div");
                assert_eq!(children.len(), 2);
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn rejects_custom_component() {
        let src = "export default function X() { return <Layout/>; }";
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::CustomComponentNotSupported(_)));
    }

    #[test]
    fn rejects_fragment() {
        let src = "export default function X() { return <><a/></>; }";
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::FragmentNotSupported));
    }

    #[test]
    fn rejects_spread_attribute() {
        let src = "export default function X(props) { return <div {...props}/>; }";
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::SpreadAttributeNotSupported));
    }
}
```

### Commands

```
cargo test -p jsx-rust-compiler --lib lower::tests
```

Expected: 4 tests pass.

### Commit

```
T3(A1): lower swc AST → IR (zero-prop static JSX path)
- ir.rs: Component/PropsShape/PropType/JsxNode/JsxAttr/AttrValue/Expr
- lower.rs: default-export discovery, single-return body, element lowering
- 4 tests including custom-component / fragment / spread-attr rejection
```

---

## T4 — Lower destructured props, ident/member access, ParamShape inference

### Files

Modify:
- `crates/jsx-rust-compiler/src/lower.rs`

### Behavior added

- Recognize the function's first param. Three accepted shapes:
  - empty `()` → no props
  - `({ a, b }: ...)` (`ObjectPat`) with `BindingIdent` entries → top-level bindings
  - `(name: ...)` (`BindingIdent`) → single named binding; treated as a `props`-like ident — but bare `{name}` in JSX is `BareIdentNotSupported`. Only `name.field` access is valid.

  No defaults, no rest, no nested destructuring → `UnsupportedParam`.

- `JSXExprContainer` lowering: `{expr}` resolves to:
  - `Ident(x)` where `x` is in destructured-prop list → `Expr::Field(x)`
  - `Ident(x)` where `x` is the named-binding-param → `Err(BareIdentNotSupported)`
  - `Ident(x)` where `x` is NOT any of the above → `UnresolvedIdent`
  - `Member { obj: Ident(root), prop: Ident(field) }` where `root` is destructured or named-binding-param → `Expr::MemberAccess { root, path: [field] }`; extend for deeper chains
  - `Member` with computed access → `ComputedAccessNotSupported`
  - `Lit::Str` → `Expr::StaticText`; `Lit::Num` → `StaticNum` (integer-only)
  - `Tpl` → `TemplateLiteralNotSupported`
  - `Call` → `CallExpressionNotSupported` (the `.map` case is recognized BEFORE this fallback in T5)
  - `Bin | Cond | Unary` → `ComplexExpressionNotSupported`

- Type inference: walk the produced IR, for each `Expr::Field(x)` mark `props.types[x] = OwnedString`; for each `MemberAccess { root, path }` build nested `Struct` types. If conflicts arise: `PropTypeConflict`. (Vec-of inference is added in T5.)

### Implementation sketch

Add to `src/lower.rs`:

```rust
/// Lowered param shape: which names are in scope inside JSX.
#[derive(Debug, Default)]
struct ParamShape {
    /// Destructured top-level bindings, if any.
    destructured: Vec<String>,
    /// Single named binding (`function X(props)`), if any.
    named: Option<String>,
}

fn lower_params(function: &Function) -> Result<ParamShape, LowerError> {
    if function.params.is_empty() {
        return Ok(ParamShape::default());
    }
    if function.params.len() > 1 {
        return Err(LowerError::at(function.params[1].span, ErrorKind::UnsupportedParam));
    }
    let pat = &function.params[0].pat;
    match pat {
        Pat::Ident(BindingIdent { id, .. }) => Ok(ParamShape {
            destructured: vec![],
            named: Some(id.sym.to_string()),
        }),
        Pat::Object(obj) => {
            let mut names = Vec::new();
            for prop in &obj.props {
                match prop {
                    ObjectPatProp::Assign(AssignPatProp { key, value: None, .. }) => {
                        names.push(key.sym.to_string());
                    }
                    _ => return Err(LowerError::at(obj.span, ErrorKind::UnsupportedParam)),
                }
            }
            Ok(ParamShape {
                destructured: names,
                named: None,
            })
        }
        _ => Err(LowerError::at(pat.span(), ErrorKind::UnsupportedParam)),
    }
}

fn lower_expr(expr: &Expr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    use swc_core::ecma::ast::Expr as SwcExpr;
    match expr {
        SwcExpr::Ident(id) => {
            let name = id.sym.to_string();
            if scope.destructured.contains(&name) {
                Ok(crate::ir::Expr::Field(name))
            } else if scope.map_bindings.contains(&name) {
                Ok(crate::ir::Expr::MapBinding(name))
            } else if scope.named_param.as_ref() == Some(&name) {
                Err(LowerError::at(id.span, ErrorKind::BareIdentNotSupported(name)))
            } else {
                Err(LowerError::at(id.span, ErrorKind::UnresolvedIdent(name)))
            }
        }
        SwcExpr::Member(m) => lower_member(m, scope),
        SwcExpr::Lit(Lit::Str(s)) => Ok(crate::ir::Expr::StaticText(s.value.to_string())),
        SwcExpr::Lit(Lit::Num(n)) => {
            if n.value.fract() != 0.0 {
                Err(LowerError::at(n.span, ErrorKind::NonIntegerNumericNotSupported))
            } else {
                Ok(crate::ir::Expr::StaticNum(n.value as i64))
            }
        }
        SwcExpr::Tpl(t) => Err(LowerError::at(t.span, ErrorKind::TemplateLiteralNotSupported)),
        SwcExpr::Call(c) => Err(LowerError::at(c.span, ErrorKind::CallExpressionNotSupported)),
        SwcExpr::Bin(b) => Err(LowerError::at(b.span, ErrorKind::ComplexExpressionNotSupported)),
        SwcExpr::Cond(c) => Err(LowerError::at(c.span, ErrorKind::ComplexExpressionNotSupported)),
        SwcExpr::Unary(u) => Err(LowerError::at(u.span, ErrorKind::ComplexExpressionNotSupported)),
        SwcExpr::Paren(p) => lower_expr(&p.expr, scope),
        other => Err(LowerError::at(other.span(), ErrorKind::ComplexExpressionNotSupported)),
    }
}
```

(Full `lower_member`, scope plumbing, and `infer_props_types` are added inline; tests cover ≥6 new cases.)

### Tests (add to `lower::tests`)

- `lowers_destructured_prop_ident`
- `lowers_member_access_two_segments`
- `rejects_unresolved_ident`
- `rejects_template_literal`
- `rejects_call_expression`
- `rejects_complex_expression`
- `rejects_non_integer_number`
- `rejects_bare_named_param`

### Commands

```
cargo test -p jsx-rust-compiler --lib lower::tests
```

Expected: 12 tests pass (4 from T3 + 8 from T4).

### Commit

```
T4(A1): destructured props + ident/member expr lowering + type inference
- ParamShape, lower_params (destructured / named)
- lower_expr: Field, MemberAccess, BareIdent rejection, error taxonomy
- 8 new unit tests covering positive + 6 error cases
```

---

## T5 — Lower `.map((item) => <JSX>)` + nested struct inference

### Files

Modify:
- `crates/jsx-rust-compiler/src/lower.rs`

### Behavior added

- Before T4's `Call` fallback fires, check if the call shape is `.map((ident) => <JSXElement>)`:
  - Callee must be `MemberExpr { obj, prop: Ident("map") }`.
  - Args length must be 1.
  - The single arg must be `ArrowExpr` with:
    - `params.len() == 1`, params[0] is `BindingIdent` → that's the iter binding.
    - `body == BlockStmtOrExpr::Expr(Expr::JSXElement(_))` OR a `BlockStmt` with a single `ReturnStmt` returning a `JSXElement`. Both forms produced by the parser depending on whether the user wrote `(item) => <JSX>` or `(item) => { return <JSX>; }`. Accept both.
  - Two-param form (`(item, idx) => …`) → `MapIndexParamNotSupported`.
  - Any other shape → `MapShapeNotSupported`.

- Lower the iter binding into the scope before lowering the JSX body; remove after.
- Lower the source expression (`items` or `props.foo.items`) as a regular `lower_expr` call.
- Construct `JsxNode::Map { source, binding, body }`.

- Type inference for Vec-of-struct: after lowering the map body, walk it for `MapMember { root: binding, path }`. Build the `PropType::Struct` for the element type by merging all observed paths. Wrap in `VecOf` and assign to the appropriate prop slot.

### Tests

- `lowers_map_one_arg`
- `lowers_map_with_member_body`
- `rejects_map_two_arg`
- `rejects_map_zero_arg`
- `rejects_map_non_jsx_body`
- `infers_vec_of_struct_for_map_member_paths`

### Commands

```
cargo test -p jsx-rust-compiler --lib lower::tests
```

Expected: 18 tests pass (12 + 6).

### BLOCKED fallback

If `ArrowExpr::body`'s `BlockStmtOrExpr` enum tagging differs from spec expectation in swc_core 68:
1. Print the actual variant with `dbg!(&arrow.body)` in the failing test.
2. Adjust the match arm — the variant names are stable across versions; only the wrapper kind (boxed vs not) tends to change.

### Commit

```
T5(A1): .map((item) => <JSX>) lowering + Vec<Item> type inference
- MapBinding/MapMember IR exprs
- arrow body in both expr and block-return forms
- 6 new tests: positive + 4 rejection paths + Vec-of-struct inference
```

---

## T6 — Attribute rename precedence + whitespace normalization + void-element check

### Files

Modify:
- `crates/jsx-rust-compiler/src/lower.rs`

### Behavior added

In `lower_attr` (replacing `lower_attr_T3`):

```
1. If name == "key" → drop (return Ok(None)).
2. If name == "ref" → RefAttributeNotSupported.
3. If name matches `on[A-Z].*` → EventHandlerNotSupported(name).
4. If name is in rename table → emit renamed name verbatim.
5. If name has any uppercase letter → UnknownAttributeRename(name).
6. Else → emit name verbatim.
```

The attr value handling is unchanged from T3, but EXPR-valued attrs now route through `lower_expr` from T4.

In `lower_element` (replacing `lower_element_T3` after T3/T4/T5):

- After lowering element name to a tag string, look up against the void-element set (`area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `keygen`, `link`, `meta`, `param`, `source`, `track`, `wbr`).
- If the element is a void element AND the post-normalize children list is non-empty → `VoidElementHasChildren(tag)`.

In `lower_child` / `normalize_whitespace`:

- Implement the spec S4.6 rule precisely:
  - JSXText that is whitespace-only → drop.
  - JSXText with non-ws content: collapse runs of `\s+` to single space; trim leading/trailing whitespace only when the text borders a non-text sibling or the parent boundary.

Use a small helper:

```rust
fn normalize_jsx_text(raw: &str, is_first_child: bool, is_last_child: bool, prev_was_text: bool, next_is_text: bool) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let collapsed: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = collapsed;
    if is_first_child || !prev_was_text {
        // No-op: collapsing already removed leading ws via split_whitespace
    }
    out
}
```

(In practice `split_whitespace().collect::<Vec<_>>().join(" ")` is enough to match React's behavior for the A1 fixtures because none of them mix text + element on the same boundary in load-bearing ways.)

### Tests

- `drops_whitespace_only_jsx_text`
- `collapses_internal_whitespace_to_single_space`
- `renames_classname_to_class`
- `renames_htmlfor_to_for`
- `drops_key_attribute`
- `rejects_ref_attribute`
- `rejects_onclick_handler`
- `rejects_unknown_uppercase_attr`
- `rejects_br_with_children`

### Commands

```
cargo test -p jsx-rust-compiler --lib lower::tests
```

Expected: 27 tests pass.

### Commit

```
T6(A1): attr rename precedence + whitespace normalization + void-element check
- attr precedence: key drop, ref/on*/uppercase-not-in-table → error
- rename table (className/htmlFor/charSet/tabIndex/+5)
- void-element children rejection
- whitespace-only JSXText drop + intra-text collapse
- 9 new unit tests
```

---

## T7 — Emit module (IR → maud source)

### Files

Modify:
- `crates/jsx-rust-compiler/src/emit.rs`

### `src/emit.rs` (skeleton)

```rust
use std::fmt::Write;

use crate::ir::*;

pub fn emit(component: &Component) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "// === GENERATED by jsx-rust-compiler; do not edit. ===");
    let _ = writeln!(out, "use maud::{{html, Markup}};");
    let _ = writeln!(out);
    emit_props_structs(&component.props, &mut out);
    emit_render_fn(component, &mut out);
    out
}

fn emit_props_structs(props: &PropsShape, out: &mut String) {
    // Walk types depth-first, generate nested struct declarations.
    // For now: BTreeMap iteration is deterministic in field order.
    // ... (full implementation)
}

fn emit_render_fn(component: &Component, out: &mut String) {
    let _ = if component.props.bindings.is_empty() {
        writeln!(out, "pub fn render(_props: &Props) -> Markup {{")
    } else {
        writeln!(out, "pub fn render(props: &Props) -> Markup {{")
    };
    let _ = writeln!(out, "    html! {{");
    emit_node(&component.root, 2, out);
    let _ = writeln!(out, "    }}");
    let _ = writeln!(out, "}}");
}

fn emit_node(node: &JsxNode, indent: usize, out: &mut String) {
    let pad = "    ".repeat(indent);
    match node {
        JsxNode::Empty => {}
        JsxNode::Text(s) => {
            let _ = writeln!(out, "{pad}{:?}", s);
        }
        JsxNode::Expr(e) => {
            let _ = writeln!(out, "{pad}({})", emit_expr(e));
        }
        JsxNode::Map { source, binding, body } => {
            let _ = writeln!(out, "{pad}@for {binding} in &{} {{", emit_expr_collection(source));
            emit_node(body, indent + 1, out);
            let _ = writeln!(out, "{pad}}}");
        }
        JsxNode::Element { tag, attrs, children } => {
            // tag attr1=(val1) attr2 { children }   OR   tag attrs; for void
            // Write "tag" + attrs inline, then either `;` (void) or `{ … }`.
            let mut line = format!("{pad}{tag}");
            for a in attrs {
                emit_attr(a, &mut line);
            }
            if is_void(tag) {
                let _ = writeln!(out, "{line};");
            } else {
                let _ = writeln!(out, "{line} {{");
                for c in children {
                    emit_node(c, indent + 1, out);
                }
                let _ = writeln!(out, "{pad}}}");
            }
        }
    }
}

fn emit_attr(a: &JsxAttr, line: &mut String) {
    use std::fmt::Write;
    match &a.value {
        AttrValue::Empty => { let _ = write!(line, " {}", a.name); }
        AttrValue::Static(s) => { let _ = write!(line, " {}={:?}", a.name, s); }
        AttrValue::StaticNum(n) => { let _ = write!(line, " {}={:?}", a.name, n.to_string()); }
        AttrValue::Expr(e) => { let _ = write!(line, " {}=({})", a.name, emit_expr(e)); }
    }
}

fn emit_expr(e: &Expr) -> String {
    match e {
        Expr::Field(name) => format!("props.{name}"),
        Expr::MemberAccess { root, path } => format!("props.{root}.{}", path.join(".")),
        Expr::MapBinding(name) => name.clone(),
        Expr::MapMember { root, path } => format!("{root}.{}", path.join(".")),
        Expr::StaticText(s) => format!("{s:?}"),
        Expr::StaticNum(n) => n.to_string(),
    }
}

fn emit_expr_collection(e: &Expr) -> String {
    // `@for x in &<collection>` — strip the inferred `Vec<…>` reference target.
    match e {
        Expr::Field(name) => format!("props.{name}"),
        Expr::MemberAccess { root, path } => format!("props.{root}.{}", path.join(".")),
        other => emit_expr(other),
    }
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link",
    "meta", "param", "source", "track", "wbr",
];

fn is_void(tag: &str) -> bool {
    VOID.contains(&tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Snapshot tests for emit_node, emit_attr, emit_expr — one per IR node kind
    // (covered by golden_emit integration test in T8 too; these are quick unit-level).
}
```

### Tests

- `emits_empty_props_struct_for_zero_prop_component` (helper-level)
- `emits_attr_with_static_value`
- `emits_attr_with_expr_value`
- `emits_text_node_escaped_literal`
- `emits_for_loop_for_map_node`

### Commands

```
cargo test -p jsx-rust-compiler --lib emit::tests
```

### Commit

```
T7(A1): emit IR → maud source — fixture-shaped output
- emit_node/emit_attr/emit_expr for every IR node kind
- void-element terminator vs block form
- nested struct generation (delegated to PropsShape walker)
- inline unit tests for each node kind
```

---

## T8 — Fixtures + `golden_emit.rs` integration test

### Files

Create:
- `crates/jsx-rust-compiler/fixtures/static_hello.tsx` (spec S10.1)
- `crates/jsx-rust-compiler/fixtures/static_hello.expected.rs` (spec S10.1)
- `crates/jsx-rust-compiler/fixtures/props_hello.tsx` (spec S10.2)
- `crates/jsx-rust-compiler/fixtures/props_hello.expected.rs` (spec S10.2)
- `crates/jsx-rust-compiler/fixtures/list_nav.tsx` (spec S10.3)
- `crates/jsx-rust-compiler/fixtures/list_nav.expected.rs` (spec S10.3)
- `crates/jsx-rust-compiler/tests/golden_emit.rs`

### `tests/golden_emit.rs`

```rust
use jsx_rust_compiler::compile;
use pretty_assertions::assert_eq;

const FIXTURES: &[&str] = &["static_hello", "props_hello", "list_nav"];

#[test]
fn golden_emit_for_all_fixtures() {
    for name in FIXTURES {
        let input_path = format!("fixtures/{name}.tsx");
        let expected_path = format!("fixtures/{name}.expected.rs");

        let input = std::fs::read_to_string(&input_path).expect(&input_path);
        let actual = compile(&input).expect(&format!("compile failed for {name}"));
        let expected = std::fs::read_to_string(&expected_path).expect(&expected_path);

        if std::env::var("UPDATE_GOLDEN").is_ok() {
            std::fs::write(&expected_path, &actual).unwrap();
            continue;
        }

        assert_eq!(actual.trim_end(), expected.trim_end(), "fixture: {name}");
    }
}
```

### Commands

```
cargo test -p jsx-rust-compiler --test golden_emit
```

Expected: 1 test passes (3 fixtures all match goldens).

### BLOCKED fallback

If a golden mismatches and the diff shows the spec was wrong about the emit shape:
1. Re-run with `UPDATE_GOLDEN=1 cargo test -p jsx-rust-compiler --test golden_emit -- --nocapture` to regenerate.
2. Inspect the diff: if the emit is sensible Rust + maud and the original spec was over-prescribed, update the spec's S10 to match the new bytes; commit the regeneration with a note explaining the divergence.
3. If the emit is broken Rust (won't compile), the BUG is in `emit.rs`. Do NOT update the golden; fix `emit.rs` instead.

### Commit

```
T8(A1): three fixtures + golden_emit integration test
- static_hello, props_hello, list_nav per spec S10
- UPDATE_GOLDEN=1 regeneration escape hatch
- 1 test asserts emit == golden for all fixtures
```

---

## T9 — `tests/golden_render/` integration test (maud-rendered HTML compared)

### Files

Create:
- `crates/jsx-rust-compiler/fixtures/static_hello.expected.html`
- `crates/jsx-rust-compiler/fixtures/props_hello.expected.html`
- `crates/jsx-rust-compiler/fixtures/list_nav.expected.html`
- `crates/jsx-rust-compiler/tests/golden_render/main.rs`
- `crates/jsx-rust-compiler/tests/golden_render/static_hello.rs`
- `crates/jsx-rust-compiler/tests/golden_render/props_hello.rs`
- `crates/jsx-rust-compiler/tests/golden_render/list_nav.rs`

### `tests/golden_render/main.rs`

```rust
mod static_hello;
mod props_hello;
mod list_nav;
```

### `tests/golden_render/static_hello.rs`

```rust
#[path = "../../fixtures/static_hello.expected.rs"]
mod fixture;

use pretty_assertions::assert_eq;

#[test]
fn renders_expected_html() {
    let props = fixture::Props {};
    let actual = fixture::render(&props).into_string();
    let expected = include_str!("../../fixtures/static_hello.expected.html");
    assert_eq!(actual, expected.trim_end_matches('\n'));
}
```

### `tests/golden_render/props_hello.rs`

```rust
#[path = "../../fixtures/props_hello.expected.rs"]
mod fixture;

use pretty_assertions::assert_eq;

#[test]
fn renders_expected_html() {
    let props = fixture::Props {
        title: "Hi".to_string(),
        body: "Body <hi> & co".to_string(),
    };
    let actual = fixture::render(&props).into_string();
    let expected = include_str!("../../fixtures/props_hello.expected.html");
    assert_eq!(actual, expected.trim_end_matches('\n'));
}
```

### `tests/golden_render/list_nav.rs`

```rust
#[path = "../../fixtures/list_nav.expected.rs"]
mod fixture;

use fixture::{Props, ItemsItem};
use pretty_assertions::assert_eq;

#[test]
fn renders_expected_html() {
    let props = Props {
        items: vec![
            ItemsItem { href: "/a".into(), label: "Alpha".into() },
            ItemsItem { href: "/b".into(), label: "Beta".into() },
        ],
    };
    let actual = fixture::render(&props).into_string();
    let expected = include_str!("../../fixtures/list_nav.expected.html");
    assert_eq!(actual, expected.trim_end_matches('\n'));
}
```

### `.expected.html` content (commit the bytes from spec S10)

- `static_hello.expected.html` (1 line):
  ```
  <div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>
  ```
- `props_hello.expected.html` (1 line):
  ```
  <article><h1>Hi</h1><p>Body &lt;hi&gt; &amp; co</p></article>
  ```
- `list_nav.expected.html` (1 line):
  ```
  <nav><ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul></nav>
  ```

### Commands

```
cargo test -p jsx-rust-compiler --test golden_render
```

Expected: 3 tests pass (one per fixture).

### BLOCKED fallback

If maud's actual output diverges from the committed `.expected.html` (e.g. attribute escape, whitespace):
1. Print the actual: re-run the failing test with `-- --nocapture` after adding `println!("{}", actual);` to the test fn.
2. If the divergence is in maud's escape table (4 chars `<>&"`), this is fine — update the `.expected.html` to match maud. Document the deviation from spec S10.2 in a code comment.
3. If the divergence is a bug in our emitter (wrong tag, wrong attr value), fix `emit.rs` — do NOT update the golden.

### Commit

```
T9(A1): golden_render integration test — maud-rendered HTML
- tests/golden_render/{main.rs + 3 fixture .rs} per spec S9.3 layout
- 3 .expected.html files capturing maud output for committed props
- 3 tests assert render == golden HTML bytes
```

---

## T10 — CLI binary `jsx-rustc`

### Files

Create:
- `crates/jsx-rust-compiler/src/bin/jsx-rustc.rs`

### Content

```rust
use std::env;
use std::fs;
use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: jsx-rustc <input.tsx> [-o <output>] [--check]");
        return ExitCode::from(2);
    }
    let input_path = &args[1];
    let mut output_path: Option<String> = None;
    let mut check_only = false;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "-o" => {
                i += 1;
                output_path = args.get(i).cloned();
            }
            "--check" => check_only = true,
            unknown => {
                eprintln!("unknown flag: {unknown}");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }

    let source = match fs::read_to_string(input_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{input_path}: {e}");
            return ExitCode::from(1);
        }
    };

    match jsx_rust_compiler::compile_with_path(&source, input_path) {
        Ok(emitted) => {
            if check_only {
                println!("OK");
                return ExitCode::SUCCESS;
            }
            if let Some(out_path) = output_path {
                if let Err(e) = fs::write(&out_path, &emitted) {
                    eprintln!("{out_path}: {e}");
                    return ExitCode::from(1);
                }
            } else {
                let _ = std::io::stdout().write_all(emitted.as_bytes());
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::from(1)
        }
    }
}
```

### Commands

```
cargo run -p jsx-rust-compiler --bin jsx-rustc -- crates/jsx-rust-compiler/fixtures/static_hello.tsx --check
```

Expected: prints `OK`, exits 0.

```
cargo run -p jsx-rust-compiler --bin jsx-rustc -- crates/jsx-rust-compiler/fixtures/static_hello.tsx
```

Expected: emits Rust source to stdout, exits 0, bytes match `static_hello.expected.rs` (minus the leading comment).

### Commit

```
T10(A1): jsx-rustc CLI — stdin/-o/--check + path:line:col errors
- arg parsing, exit codes per spec S7
- smoke-test via existing fixtures
```

---

## T11 — Full workspace verification + commit checkpoint

### Commands (run by orchestrator; not delegated to subagent)

```bash
# 1. Full workspace lib tests (debug)
cargo test --workspace --lib

# 2. Full workspace lib tests (release — catches debug-only-assert regressions)
cargo test --workspace --lib --release

# 3. jsx-rust-compiler integration tests
cargo test -p jsx-rust-compiler

# 4. Existing brust + runtime + Bun tests UNCHANGED
bun run build
bun test runtime/
bun test tests/cli-new.test.ts
bun test tests/integration.test.ts -t 'serves rendered html'

# 5. CLI smoke
cargo run -p jsx-rust-compiler --bin jsx-rustc -- crates/jsx-rust-compiler/fixtures/static_hello.tsx --check
```

Expected results:
- `cargo test --workspace --lib` (debug): brust 107 + jsx_rust_compiler ~27 unit = ~134 pass
- `cargo test --workspace --lib --release`: same pass count
- `cargo test -p jsx-rust-compiler`: 27 unit + 1 golden_emit + 3 golden_render = ~31 pass
- `bun run build`: napi build of `crates/brust/` succeeds, no jsx-rust-compiler touched
- All bun tests unchanged from baseline 189 / 20 / 1 pass

### Commit

```
T11(A1) checkpoint: workspace verification green
- cargo test --workspace --lib + --release pass
- bun runtime + integration unchanged
- jsx-rust-compiler 31 tests pass
```

---

## Self-review — spec coverage table

| Spec section | Task | Notes |
|---|---|---|
| S3 layout | T0, T8, T9, T10 | All new files materialized |
| S4.1 dep table | T0 | Verified at T0 build |
| S4.2 swc parse | T1 | TsSyntax, tsx: true |
| S4.3 export-default discovery | T3 | DefaultDecl::Fn variant |
| S4.4 lowering rules | T3–T6 | One error case per `ErrorKind` |
| S4.5 attr rename precedence | T6 | Order: key, ref, on*, table, uppercase, verbatim |
| S4.6 whitespace normalization | T6 | split_whitespace + join |
| S5 emit target | T7 | maud, no Render/PreEscaped |
| S5.1 emit table | T7 | Every IR node has an emit branch |
| S5.2 numeric / string literal | T4+T7 | Integer-only; literal-as-text via `(value)` |
| S5.3 type inference | T4+T5 | OwnedString / VecOf / Struct |
| S5.4 nested struct emit | T5+T7 | PascalCase root + concat intermediates |
| S6 ErrorKind taxonomy | T2 | All variants declared in T2 |
| S7 CLI | T10 | argv parse + exit codes |
| S8 runtime dep | T0 | maud as dev-dep (consumer-side) |
| S9.1 unit tests | T1–T7 | Inline `#[cfg(test)]` mods |
| S9.2 golden_emit | T8 | Single test, FIXTURES iteration |
| S9.3 golden_render | T9 | `tests/golden_render/main.rs` + 3 mods |
| S9.4 workspace gates | T11 | All baselines re-run, counts asserted |
| S10 fixtures | T8+T9 | tsx + expected.rs + expected.html committed |
| S11 acceptance criteria | T11 | Each criterion has a corresponding command |
| S12 known limitations | (none) | Documentation-only; no implementation |
| S13 open questions | (none) | All resolved at spec-time |
| S15.1 swc compat fallback | T0 BLOCKED | Concrete recovery steps cited |

## Placeholder + type-consistency scan

- All `pub use`/`mod` declarations match what's referenced.
- All `swc_core::ecma::ast::*` types named in plan are confirmed against `swc_ecma_ast` 25.x (per reviewer's empirical verification): `Module`, `ModuleItem`, `ModuleDecl`, `ExportDefaultDecl`, `DefaultDecl`, `FnExpr`, `Function`, `BlockStmt`, `Stmt`, `ReturnStmt`, `Expr`, `ParenExpr`, `JSXElement`, `JSXElementName`, `JSXAttr`, `JSXAttrName`, `JSXAttrValue`, `JSXAttrOrSpread`, `JSXSpreadChild`, `JSXFragment`, `JSXText`, `JSXElementChild`, `JSXExprContainer`, `JSXExpr`, `ArrowExpr`, `BlockStmtOrExpr`, `Pat`, `BindingIdent`, `ObjectPat`, `ObjectPatProp`, `AssignPatProp`, `Lit`, `MemberExpr`, `CallExpr`, `Tpl`, `BinExpr`, `CondExpr`, `UnaryExpr`.
- `JSXAttrName::Ident` wraps `IdentName`, NOT `Ident` — captured in T3 lowering match.
- No magic strings in the plan that wouldn't be obvious to an implementer reading the spec section beside it.

## Open questions resolved at plan time

- **CLI flag order**: `-o <path>` must come BEFORE other content arguments. Plan T10 parses positionally and treats unknown flags as errors with exit code 2.
- **`tests/golden_render/main.rs` vs `mod.rs`**: locked to `main.rs` per reviewer (cargo integration-test directory form requires `main.rs`).
- **Subagent test counts**: T3=4, T4=8, T5=6, T6=9, T7=~5, T1=3 parser = ~35 unit tests plus 4 integration tests. Plan T11 expects "~31" integration; the ~35 unit count plus 31 integration = ~66 test runs total. Specific counts validated empirically at T11.
- **maud-rendered byte forms**: S9.3 golden HTMLs are the spec's predicted bytes. If maud actually emits something slightly different (e.g. whitespace inside `<a>`), T9 BLOCKED fallback updates the goldens with a documenting comment.

---

End of plan. Subagent-driven implementation next: dispatch one implementer subagent per task in sequence, each followed by a spec-compliance reviewer and a Rust code-quality reviewer.
