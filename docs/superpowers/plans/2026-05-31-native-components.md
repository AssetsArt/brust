# Native Page SSR Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `JsxNode::SsrComponent` to the jsx-rust-compiler so non-Island capitalized components on `native: true` routes compile to `{{ comp_N_html | safe }}` Jinja slots, with a JS worker factory rendering the full React subtree at request time.

**Architecture:** The Rust compiler gains a new IR node (`SsrComponent`) and emitter (`emit_factory`) alongside the existing Jinja emitter. A `ComponentMeta` manifest is generated per route alongside `IslandMeta`. The TS build step writes a `<Name>.factory.ts` that the worker imports at request time; `resolveComponentContext` runs in `Promise.all` alongside `resolveIslandContext`.

**Tech Stack:** Rust (swc, napi-derive), TypeScript/Bun, React `renderToString`, minijinja (Rust-side, unchanged)

---

## File map

| File | Change |
|---|---|
| `crates/jsx-rust-compiler/src/ir.rs` | add `JsxNode::SsrComponent` |
| `crates/jsx-rust-compiler/src/lib.rs` | `Compiled` → add `components`; `ComponentMeta` struct; `components_to_json`; walker functions |
| `crates/jsx-rust-compiler/src/lower.rs` | `lower_element` → third recognition path; new `lower_ssr_component` |
| `crates/jsx-rust-compiler/src/emit_jinja.rs` | add `SsrComponent` arm → `{{ comp_N_html \| safe }}` |
| `crates/jsx-rust-compiler/src/emit_factory.rs` | **new** — IR → `(ctx) => h(…)` TS factory expression |
| `crates/brust/src/jsx_compile.rs` | `NapiCompiledJsx` gains `components_json`; `compile_jsx` passes it through |
| `runtime/cli/native-routes-emit.ts` | after `compileJsx`: write `.components.json` + `.factory.ts`; scan SSR component sources for Island names |
| `runtime/islands/native-render.ts` | add `NativeComponentEntry`, `loadComponentManifest`, `resolveComponentContext` |
| `runtime/routes.ts` | `Promise.all([resolveIslandContext, resolveComponentContext])` in native branch; 413 guard on merged ctx |

---

### Task 1: IR node + `Compiled` struct additions

**Files:**
- Modify: `crates/jsx-rust-compiler/src/ir.rs`
- Modify: `crates/jsx-rust-compiler/src/lib.rs`

- [ ] **Step 1: Add `JsxNode::SsrComponent` to ir.rs**

In `crates/jsx-rust-compiler/src/ir.rs`, add after `JsxNode::Island { … }`:

```rust
/// Non-Island capitalized component on a native route. Lowered from any
/// capitalised tag that is not `<Island>` or `<BrustPage>`. The emitter
/// outputs a `{{ comp_N_html | safe }}` slot; the JS worker fills it via a
/// generated factory function.
SsrComponent {
    /// Source identifier from the tag name (e.g. `Layout`).
    component: String,
    /// Source-order index among SSR components (set by `number_ssr_components`).
    instance: usize,
    /// Lowered attrs via dedicated camelCase-safe attr loop.
    props: Vec<JsxAttr>,
    /// Lowered children (may contain Islands, elements, etc.).
    children: Vec<JsxNode>,
},
```

- [ ] **Step 2: Add `ComponentMeta` and `components` field to `Compiled` in lib.rs**

In `crates/jsx-rust-compiler/src/lib.rs`, after `IslandMeta`:

```rust
/// One entry in the SSR-component manifest. Parallel to `IslandMeta`.
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentMeta {
    /// Identifier from the JSX tag name, e.g. `"Layout"`.
    pub component: String,
    /// Source-order index among SSR components on this page.
    pub instance: usize,
    /// The `(ctx) => h(Component, {…}, …)` TypeScript factory expression.
    pub factory_expr: String,
    /// All component-identifier names referenced inside the factory expression
    /// (the SSR component itself + Island component names). The TS build step
    /// imports each from `pageImports`. Includes duplicates if referenced
    /// multiple times — the TS side dedupes.
    pub referenced_components: Vec<String>,
    /// True if any `<Island>` node appears in this component's factory tree.
    /// When true the TS build step adds `import { Island } from 'brustjs'`.
    pub uses_island: bool,
}
```

Add `components: Vec<ComponentMeta>` to `Compiled`:

```rust
pub struct Compiled {
    pub template: String,
    pub islands: Vec<IslandMeta>,
    pub components: Vec<ComponentMeta>,  // ← new
}
```

- [ ] **Step 3: Add walker stubs for `SsrComponent` in lib.rs**

In `number_islands`, add an arm that recurses into `SsrComponent.children` to number any Islands inside (Islands inside SSR components still get numbered so they can be referenced inside the factory tree):

```rust
JsxNode::SsrComponent { children, .. } => {
    for c in children {
        number_islands(c, counter);
    }
}
```

In `collect_islands`, add an arm that **skips** `SsrComponent.children` (Islands inside SSR components are NOT in `.islands.json` — their props are written by Island.tsx React-path render into the DOM directly):

```rust
JsxNode::SsrComponent { .. } => {}
```

Add `number_ssr_components` (new function, after `number_islands`):

```rust
/// Assign source-order `instance` indices to every TOP-LEVEL `SsrComponent`
/// node. Does NOT recurse into `SsrComponent.children` — nested SSR
/// components render inline inside their parent's factory, not as separate
/// `{{ comp_N_html }}` slots.
fn number_ssr_components(node: &mut JsxNode, counter: &mut usize) {
    match node {
        JsxNode::SsrComponent { instance, .. } => {
            *instance = *counter;
            *counter += 1;
            // Do not recurse into children — nested SSR components are not
            // separately numbered/tracked (they render inside parent factory).
        }
        JsxNode::Element { children, .. } => {
            for c in children {
                number_ssr_components(c, counter);
            }
        }
        JsxNode::Document { body, .. } => {
            for c in body {
                number_ssr_components(c, counter);
            }
        }
        JsxNode::Map { body, .. } => number_ssr_components(body, counter),
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::Island { .. } => {}
    }
}
```

Add `collect_components` (new function, after `collect_islands`):

```rust
/// Depth-first pre-order walk collecting every TOP-LEVEL `SsrComponent` in
/// source order. Does NOT recurse into `SsrComponent.children`. `factory_expr`
/// is left empty — `compile_full` fills it from `emit_factory::emit`.
fn collect_components(node: &JsxNode, out: &mut Vec<ComponentMeta>) {
    match node {
        JsxNode::SsrComponent { component, instance, .. } => {
            // Don't recurse — nested SSR components render inside parent factory.
            out.push(ComponentMeta {
                component: component.clone(),
                instance: *instance,
                factory_expr: String::new(),
                referenced_components: Vec::new(),
                uses_island: false,
            });
        }
        JsxNode::Element { children, .. } => {
            for child in children {
                collect_components(child, out);
            }
        }
        JsxNode::Document { body, .. } => {
            for child in body {
                collect_components(child, out);
            }
        }
        JsxNode::Map { body, .. } => collect_components(body, out),
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::Island { .. } => {}
    }
}
```

Add `components_to_json` (new function, after `islands_to_json`):

```rust
/// Hand-rolled JSON for the component manifest. Mirrors `islands_to_json`.
/// Keys: `component`, `instance`, `factoryExpr`, `referencedComponents`,
/// `usesIsland`. Empty slice → `"[]"`.
pub fn components_to_json(components: &[ComponentMeta]) -> String {
    if components.is_empty() {
        return "[]".to_string();
    }
    let mut out = String::from("[");
    for (i, c) in components.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"component\":\"");
        out.push_str(&json_escape(&c.component));
        out.push_str("\",\"instance\":");
        out.push_str(&c.instance.to_string());
        out.push_str(",\"factoryExpr\":\"");
        out.push_str(&json_escape(&c.factory_expr));
        out.push_str("\",\"referencedComponents\":[");
        for (j, r) in c.referenced_components.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push('"');
            out.push_str(&json_escape(r));
            out.push('"');
        }
        out.push_str("],\"usesIsland\":");
        out.push_str(if c.uses_island { "true" } else { "false" });
        out.push('}');
    }
    out.push(']');
    out
}
```

- [ ] **Step 4: Wire into `compile_full`**

In `compile_full`, add `number_ssr_components` + `collect_components` + `emit_factory::emit` calls and populate `components`. Replace the current `Ok(Compiled { template, islands })` with:

```rust
pub fn compile_full(source: &str, path: &str) -> Result<Compiled, CompileError> {
    let parsed = parser::parse(source, path).map_err(|e| CompileError {
        path: path.to_string(),
        line: 0,
        col: 0,
        kind: ErrorKind::Parse(e.to_string()),
    })?;

    let mut ir = lower::lower(&parsed).map_err(|e| CompileError::from_lower(e, path, &parsed))?;
    let mut n = 0;
    number_islands(&mut ir.root, &mut n);
    let mut m = 0;
    number_ssr_components(&mut ir.root, &mut m);

    let template = emit_jinja::emit(&ir);
    let factory_outputs = emit_factory::emit(&ir);   // Vec<FactoryOutput>

    let mut islands = Vec::new();
    collect_islands(&ir.root, &mut islands);

    let mut components: Vec<ComponentMeta> = Vec::new();
    collect_components(&ir.root, &mut components);
    // Zip factory outputs into component entries (same source order).
    for (comp, fo) in components.iter_mut().zip(factory_outputs) {
        comp.factory_expr = fo.expr;
        comp.referenced_components = fo.referenced;
        comp.uses_island = fo.uses_island;
    }

    Ok(Compiled { template, islands, components })
}
```

`emit_factory::emit` is defined in Task 4. For now add a stub:

```rust
// crates/jsx-rust-compiler/src/emit_factory.rs (stub — Task 4 fills this in)
pub struct FactoryOutput {
    pub expr: String,
    pub referenced: Vec<String>,
    pub uses_island: bool,
}
pub fn emit(_component: &crate::ir::Component) -> Vec<FactoryOutput> {
    vec![]
}
```

Add `mod emit_factory;` to `lib.rs`.

- [ ] **Step 5: Also add `SsrComponent` arm to `infer_props_types` in lower.rs**

Search for `fn infer_props_types` in `lower.rs`. Add an arm treating `SsrComponent` as opaque (don't recurse into props or children — it has its own type scope):

```rust
JsxNode::SsrComponent { .. } => Ok(()),
```

- [ ] **Step 6: Verify existing tests still pass**

```bash
cd crates/jsx-rust-compiler && cargo test 2>&1 | tail -5
```

Expected: all existing tests pass (no behaviour change yet — stub emits `vec![]`).

- [ ] **Step 7: Commit**

```bash
git add crates/jsx-rust-compiler/src/ir.rs \
        crates/jsx-rust-compiler/src/lib.rs \
        crates/jsx-rust-compiler/src/emit_factory.rs \
        crates/jsx-rust-compiler/src/lower.rs
git commit -m "feat(compiler): IR SsrComponent node + ComponentMeta scaffold"
```

---

### Task 2: `lower_ssr_component` — recognise capitalized tags

**Files:**
- Modify: `crates/jsx-rust-compiler/src/lower.rs`
- Test: `crates/jsx-rust-compiler/src/lower.rs` (inline tests)

- [ ] **Step 1: Write failing tests**

Add at the end of `lower.rs` tests module:

```rust
#[test]
fn lower_ssr_component_leaf() {
    let src = r#"export default function Page({ greeting }) {
  return <Header user={greeting} />;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(c.components.len(), 1);
    assert_eq!(c.components[0].component, "Header");
    assert_eq!(c.components[0].instance, 0);
    assert!(c.islands.is_empty());
}

#[test]
fn lower_ssr_component_with_children_and_island() {
    let src = r#"export default function Page({ greeting, data }) {
  return <Layout title={greeting}><h1>{greeting}</h1><Island component={Counter} props={data.counter} hydrate="load" /></Layout>;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(c.components.len(), 1);
    assert_eq!(c.components[0].component, "Layout");
    // Islands inside SsrComponent children are NOT in island manifest
    assert!(c.islands.is_empty(), "islands inside SsrComponent must not appear in manifest");
}

#[test]
fn lower_ssr_component_camelcase_props_accepted() {
    // lower_attr rejects camelCase — lower_ssr_component must not use it
    let src = r#"export default function Page({ data }) {
  return <Card userName={data.name} isActive={data.active} />;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(c.components.len(), 1);
    assert_eq!(c.components[0].component, "Card");
}

#[test]
fn lower_ssr_component_event_handler_rejected() {
    let src = r#"export default function Page({ data }) {
  return <Card onClick={data.fn} />;
}"#;
    let err = compile_full(src, "<test>").unwrap_err();
    assert!(
        matches!(err.kind, ErrorKind::EventHandlerNotSupported(_)),
        "expected EventHandlerNotSupported, got {:?}", err.kind
    );
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd crates/jsx-rust-compiler && cargo test lower_ssr_component 2>&1 | grep -E "FAILED|error"
```

Expected: tests fail (function doesn't exist yet).

- [ ] **Step 3: Add `lower_ssr_component` to lower.rs**

Add the new function after `lower_brust_page`:

```rust
/// Lower a capitalized, non-Island, non-BrustPage JSX element into
/// `JsxNode::SsrComponent`. Uses a dedicated attr loop (NOT `lower_attr`)
/// that accepts arbitrary camelCase prop names — component props are not HTML
/// attributes and must not be renamed or rejected on case alone.
fn lower_ssr_component(
    el: &JSXElement,
    scope: &Scope,
    in_map: bool,
) -> Result<JsxNode, LowerError> {
    let component = match &el.opening.name {
        JSXElementName::Ident(ident) => ident.sym.to_string(),
        _ => unreachable!("caller guarantees Ident"),
    };

    let mut props: Vec<JsxAttr> = Vec::new();
    for attr in &el.opening.attrs {
        let JSXAttrOrSpread::JSXAttr(jsx_attr) = attr else {
            return Err(LowerError::at(
                el.opening.span,
                ErrorKind::SpreadAttributeNotSupported,
            ));
        };
        let name = match &jsx_attr.name {
            JSXAttrName::Ident(id) => id.sym.to_string(),
            JSXAttrName::JSXNamespacedName(n) => {
                return Err(LowerError::at(n.span, ErrorKind::NamespacedAttrNotSupported));
            }
        };
        // Drop React-internal attrs; reject ref and event handlers.
        match name.as_str() {
            "key" => continue,
            "ref" => {
                return Err(LowerError::at(jsx_attr.span, ErrorKind::RefAttributeNotSupported))
            }
            _ if is_event_handler(&name) => {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::EventHandlerNotSupported(name),
                ))
            }
            _ => {}
        }
        let value = match &jsx_attr.value {
            None => AttrValue::Empty,
            Some(JSXAttrValue::Str(s)) => AttrValue::Static(s.value.to_string_lossy().into_owned()),
            Some(JSXAttrValue::JSXExprContainer(c)) => match &c.expr {
                JSXExpr::JSXEmptyExpr(_) => {
                    return Err(LowerError::at(c.span, ErrorKind::JsxInAttrNotSupported))
                }
                JSXExpr::Expr(e) => match lower_expr(e, scope)? {
                    crate::ir::Expr::StaticNum(n) => AttrValue::StaticNum(n),
                    crate::ir::Expr::StaticText(s) => AttrValue::Static(s),
                    expr => AttrValue::Expr(expr),
                },
            },
            _ => return Err(LowerError::at(jsx_attr.span, ErrorKind::JsxInAttrNotSupported)),
        };
        props.push(JsxAttr { name, value });
    }

    let mut children: Vec<JsxNode> = Vec::new();
    for child in &el.children {
        if let Some(node) = lower_child(child, scope, in_map)? {
            children.push(node);
        }
    }

    Ok(JsxNode::SsrComponent {
        component,
        instance: 0, // set by number_ssr_components
        props,
        children,
    })
}
```

- [ ] **Step 4: Wire into `lower_element`**

In `lower_element`, add a third recognition block **after** the `<Island>` check and **before** `lower_element_name`:

```rust
// Third recognition path: any other capitalised tag → SSR component.
// Must appear BEFORE `lower_element_name` (which rejects uppercase with
// `CustomComponentNotSupported`).
if let JSXElementName::Ident(ident) = &el.opening.name {
    let s = ident.sym.as_ref();
    if s.starts_with(|c: char| c.is_ascii_uppercase())
        && s != "Island"
        && s != "BrustPage"
    {
        return lower_ssr_component(el, scope, in_map);
    }
}
```

- [ ] **Step 5: Run tests**

```bash
cd crates/jsx-rust-compiler && cargo test lower_ssr_component 2>&1 | tail -10
```

Expected: all 4 new tests pass.

- [ ] **Step 6: Run full test suite to catch regressions**

```bash
cd crates/jsx-rust-compiler && cargo test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/jsx-rust-compiler/src/lower.rs
git commit -m "feat(compiler): lower_ssr_component — recognise non-Island capitalized tags"
```

---

### Task 3: `emit_jinja` arm + golden test

**Files:**
- Modify: `crates/jsx-rust-compiler/src/emit_jinja.rs`
- Test: inline in `emit_jinja.rs` or `lib.rs`

- [ ] **Step 1: Write failing test**

Add to tests in `lib.rs`:

```rust
#[test]
fn ssr_component_emits_comp_slot() {
    let src = r#"export default function Page({ greeting }) {
  return <Layout title={greeting} />;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(c.template, "{{ comp_0_html | safe }}");
}

#[test]
fn ssr_component_with_sibling_element() {
    let src = r#"export default function Page({ greeting }) {
  return <div><Header /><p>{greeting}</p></div>;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(c.template, "<div>{{ comp_0_html | safe }}<p>{{ greeting }}</p></div>");
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd crates/jsx-rust-compiler && cargo test ssr_component_emits_comp 2>&1 | grep -E "FAILED|panicked"
```

Expected: FAILED (template is empty string from stub / panics on missing match arm).

- [ ] **Step 3: Add arm to `emit_node` in emit_jinja.rs**

In `emit_jinja.rs`, inside `fn emit_node`, add after the `JsxNode::Island` arm:

```rust
JsxNode::SsrComponent { instance, .. } => {
    let _ = write!(out, "{{{{ comp_{instance}_html | safe }}}}");
}
```

- [ ] **Step 4: Run tests**

```bash
cd crates/jsx-rust-compiler && cargo test ssr_component_emits_comp ssr_component_with_sibling 2>&1 | tail -5
```

Expected: both pass.

- [ ] **Step 5: Run full suite**

```bash
cd crates/jsx-rust-compiler && cargo test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add crates/jsx-rust-compiler/src/emit_jinja.rs
git commit -m "feat(compiler): emit {{ comp_N_html | safe }} for SsrComponent"
```

---

### Task 4: `emit_factory.rs` — IR → TS factory expression

**Files:**
- Modify: `crates/jsx-rust-compiler/src/emit_factory.rs` (stub → real)
- Test: inline tests

- [ ] **Step 1: Write failing tests in lib.rs**

```rust
#[test]
fn factory_leaf_component() {
    let src = r#"export default function Page({ greeting }) {
  return <Header user={greeting} />;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(
        c.components[0].factory_expr,
        "(ctx) => h(Header, {user: ctx.greeting})"
    );
    assert_eq!(c.components[0].referenced_components, vec!["Header"]);
    assert!(!c.components[0].uses_island);
}

#[test]
fn factory_component_with_static_prop() {
    let src = r#"export default function Page({ data }) {
  return <Card label="hello" count={data.n} />;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(
        c.components[0].factory_expr,
        r#"(ctx) => h(Card, {label: "hello", count: ctx.data.n})"#
    );
}

#[test]
fn factory_component_with_children_and_island() {
    let src = r#"export default function Page({ greeting, data }) {
  return <Layout title={greeting}><h1>{greeting}</h1><Island component={Counter} props={data.counter} hydrate="load" /></Layout>;
}"#;
    let c = compile_full(src, "<test>").unwrap();
    assert_eq!(
        c.components[0].factory_expr,
        r#"(ctx) => h(Layout, {title: ctx.greeting}, h("h1", null, ctx.greeting), h(Island, {component: Counter, props: ctx.data.counter, hydrate: "load"}))"#
    );
    assert!(c.components[0].uses_island);
    assert!(c.components[0].referenced_components.contains(&"Layout".to_string()));
    assert!(c.components[0].referenced_components.contains(&"Counter".to_string()));
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd crates/jsx-rust-compiler && cargo test factory_leaf factory_component 2>&1 | grep -E "FAILED|panicked"
```

Expected: FAILED (stub returns `vec![]`, so `components[0]` panics).

- [ ] **Step 3: Implement `emit_factory.rs`**

Replace the stub with the real implementation:

```rust
//! Emit IR → TypeScript factory expressions for SSR components.
//!
//! Each top-level `JsxNode::SsrComponent` in the IR produces one
//! `FactoryOutput` containing the `(ctx) => h(Component, {…}, …)` expression
//! and metadata about which component identifiers are referenced (for the
//! TS build step to generate the correct import block).
//!
//! Nested `SsrComponent` nodes (inside another SsrComponent's children)
//! are emitted inline as `h(NestedComp, {…})` — they do NOT get their own
//! `FactoryOutput` entry (no separate `{{ comp_N_html }}` Jinja slot).

use std::fmt::Write;
use crate::ir::*;

/// Result of emitting one top-level SsrComponent's factory.
pub struct FactoryOutput {
    /// The `(ctx) => h(Component, {…}, …)` expression string.
    pub expr: String,
    /// All component identifiers referenced in the expression (deduped by caller).
    pub referenced: Vec<String>,
    /// True if any `<Island>` node appears in the tree (signals brustjs import).
    pub uses_island: bool,
}

/// Walk `component.root` and return one `FactoryOutput` per top-level
/// `SsrComponent` node, in source order (matching `collect_components` order).
pub fn emit(component: &Component) -> Vec<FactoryOutput> {
    let mut out = Vec::new();
    collect_factories(&component.root, &mut out);
    out
}

fn collect_factories(node: &JsxNode, out: &mut Vec<FactoryOutput>) {
    match node {
        JsxNode::SsrComponent { component, props, children, .. } => {
            let mut fo = FactoryOutput {
                expr: String::new(),
                referenced: Vec::new(),
                uses_island: false,
            };
            fo.referenced.push(component.clone());
            let _ = write!(fo.expr, "(ctx) => ");
            emit_h(component, props, children, &mut fo);
            out.push(fo);
            // Do NOT recurse into children — nested SsrComponents are inline.
        }
        JsxNode::Element { children, .. } => {
            for c in children { collect_factories(c, out); }
        }
        JsxNode::Document { body, .. } => {
            for c in body { collect_factories(c, out); }
        }
        JsxNode::Map { body, .. } => collect_factories(body, out),
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) | JsxNode::Island { .. } => {}
    }
}

/// Emit `h(ComponentName, {props…}, children…)` into `fo.expr`.
fn emit_h(component: &str, props: &[JsxAttr], children: &[JsxNode], fo: &mut FactoryOutput) {
    let _ = write!(fo.expr, "h({component}, {{");
    for (i, attr) in props.iter().enumerate() {
        if i > 0 { fo.expr.push_str(", "); }
        emit_attr_kv(attr, fo);
    }
    fo.expr.push('}');
    for child in children {
        fo.expr.push_str(", ");
        emit_child(child, fo);
    }
    fo.expr.push(')');
}

fn emit_attr_kv(attr: &JsxAttr, fo: &mut FactoryOutput) {
    let _ = write!(fo.expr, "{}: ", attr.name);
    match &attr.value {
        AttrValue::Empty => fo.expr.push_str("true"),
        AttrValue::Static(s) => {
            fo.expr.push('"');
            fo.expr.push_str(&s.replace('"', "\\\""));
            fo.expr.push('"');
        }
        AttrValue::StaticNum(n) => { let _ = write!(fo.expr, "{n}"); }
        AttrValue::Expr(e) => fo.expr.push_str(&emit_expr(e)),
    }
}

fn emit_child(node: &JsxNode, fo: &mut FactoryOutput) {
    match node {
        JsxNode::Element { tag, attrs, children } => {
            let _ = write!(fo.expr, "h(\"{tag}\", ");
            if attrs.is_empty() {
                fo.expr.push_str("null");
            } else {
                fo.expr.push('{');
                for (i, a) in attrs.iter().enumerate() {
                    if i > 0 { fo.expr.push_str(", "); }
                    emit_attr_kv(a, fo);
                }
                fo.expr.push('}');
            }
            for c in children {
                fo.expr.push_str(", ");
                emit_child(c, fo);
            }
            fo.expr.push(')');
        }
        JsxNode::Text(s) => {
            fo.expr.push('"');
            fo.expr.push_str(&s.replace('"', "\\\""));
            fo.expr.push('"');
        }
        JsxNode::Expr(e) => {
            fo.expr.push_str(&emit_expr(e));
        }
        JsxNode::Island { component, props_path, hydrate, ssr, .. } => {
            fo.uses_island = true;
            fo.referenced.push(component.clone());
            let _ = write!(
                fo.expr,
                "h(Island, {{component: {component}, props: {props}, hydrate: \"{hydrate}\"",
                props = format!("ctx.{props_path}"),
            );
            if *ssr { fo.expr.push_str(", ssr: true"); }
            fo.expr.push_str("})");
        }
        JsxNode::SsrComponent { component, props, children, .. } => {
            // Nested SSR component: emit inline h(…) — not a separate factory entry.
            fo.referenced.push(component.clone());
            emit_h(component, props, children, fo);
        }
        JsxNode::Map { source, binding, body } => {
            let _ = write!(fo.expr, "{}.map(({binding}) => ", emit_expr(source));
            emit_child(body, fo);
            fo.expr.push(')');
        }
        JsxNode::Empty => {}
        JsxNode::Document { .. } => {} // cannot appear as child
    }
}

fn emit_expr(e: &Expr) -> String {
    match e {
        Expr::Field(f) => format!("ctx.{f}"),
        Expr::MemberAccess { root, path } => format!("ctx.{root}.{}", path.join(".")),
        Expr::MapBinding(b) => b.clone(),
        Expr::MapMember { root, path } => format!("{root}.{}", path.join(".")),
        Expr::StaticText(s) => format!("\"{}\"", s.replace('"', "\\\"")),
        Expr::StaticNum(n) => n.to_string(),
    }
}
```

- [ ] **Step 4: Run factory tests**

```bash
cd crates/jsx-rust-compiler && cargo test factory_leaf factory_component 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 5: Run full suite**

```bash
cd crates/jsx-rust-compiler && cargo test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add crates/jsx-rust-compiler/src/emit_factory.rs
git commit -m "feat(compiler): emit_factory — IR to TypeScript createElement factory expression"
```

---

### Task 5: NAPI — expose `components_json`

**Files:**
- Modify: `crates/brust/src/jsx_compile.rs`
- Test: `crates/brust/src/jsx_compile.rs` (inline)

- [ ] **Step 1: Write failing test**

Add at the bottom of `jsx_compile.rs`:

```rust
#[cfg(test)]
mod tests {
    // Note: cannot call compile_jsx directly in unit tests (it's napi-bound);
    // test the underlying Rust API instead.
    use jsx_rust_compiler::{compile_full, components_to_json};

    #[test]
    fn compile_jsx_exposes_components_json() {
        let src = r#"export default function Page({ greeting }) {
  return <Layout title={greeting} />;
}"#;
        let compiled = compile_full(src, "<test>").unwrap();
        let json = components_to_json(&compiled.components);
        assert!(json.contains("\"component\":\"Layout\""));
        assert!(json.contains("\"instance\":0"));
        assert!(json.contains("\"factoryExpr\":"));
    }
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd crates/brust && cargo test compile_jsx_exposes 2>&1 | grep -E "error|FAILED"
```

Expected: compile error — `components_to_json` not yet public or `components_json` field not in `NapiCompiledJsx`.

- [ ] **Step 3: Update `NapiCompiledJsx` and `compile_jsx` in jsx_compile.rs**

Replace the current content with:

```rust
//! napi binding for the JSX→jinja compiler (the `jsx-rust-compiler` crate).
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[allow(dead_code)]
#[napi(object)]
pub struct NapiCompiledJsx {
    pub template: String,
    /// Island manifest as JSON (`"[]"` when no `<Island>`). camelCase keys match
    /// `RawIslandEntry` in native-routes-emit.ts.
    pub islands_json: String,
    /// SSR component manifest as JSON (`"[]"` when no SSR components). camelCase
    /// keys: `component`, `instance`, `factoryExpr`, `referencedComponents`,
    /// `usesIsland`.
    pub components_json: String,
}

#[allow(dead_code)]
#[napi]
pub fn compile_jsx(source: String, path: String) -> Result<NapiCompiledJsx> {
    match jsx_rust_compiler::compile_full(&source, &path) {
        Ok(compiled) => Ok(NapiCompiledJsx {
            template: compiled.template,
            islands_json: jsx_rust_compiler::islands_to_json(&compiled.islands),
            components_json: jsx_rust_compiler::components_to_json(&compiled.components),
        }),
        Err(e) => Err(Error::from_reason(format!("{e}"))),
    }
}

#[cfg(test)]
mod tests {
    use jsx_rust_compiler::{compile_full, components_to_json};

    #[test]
    fn compile_jsx_exposes_components_json() {
        let src = r#"export default function Page({ greeting }) {
  return <Layout title={greeting} />;
}"#;
        let compiled = compile_full(src, "<test>").unwrap();
        let json = components_to_json(&compiled.components);
        assert!(json.contains("\"component\":\"Layout\""));
        assert!(json.contains("\"instance\":0"));
        assert!(json.contains("\"factoryExpr\":"));
    }
}
```

- [ ] **Step 4: Rebuild the addon**

```bash
cd runtime && bun run build 2>&1 | tail -5
```

Expected: build succeeds, `.node` file updated.

- [ ] **Step 5: Verify TS types see the new field**

```bash
cd runtime && node -e "const n = require('./index.js'); const r = n.compileJsx('export default function P({x}){return <Foo a={x}/>;}', 't.tsx'); console.log(Object.keys(r))"
```

Expected: `[ 'template', 'islandsJson', 'componentsJson' ]`

- [ ] **Step 6: Run full Rust test suite**

```bash
cargo test --workspace 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add crates/brust/src/jsx_compile.rs crates/jsx-rust-compiler/src/lib.rs
git commit -m "feat(napi): expose componentsJson from compile_jsx"
```

---

### Task 6: TS build step — `.components.json` + `.factory.ts` + Island scan

**Files:**
- Modify: `runtime/cli/native-routes-emit.ts`
- Test: `runtime/cli/native-routes-emit.test.ts`

- [ ] **Step 1: Write failing tests**

In `runtime/cli/native-routes-emit.test.ts` (or alongside the existing test file), add:

```typescript
import { test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { emitNativeTemplates } from './native-routes-emit.ts'

// NOTE: these tests need a compiled addon. Run `cd runtime && bun run build` first.

test('emitNativeTemplates writes components.json for SSR component', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(path.join(tmpdir(), 'brust-comp-test-'))
  
  // Minimal Layout component
  const layoutSrc = `export default function Layout({ title, children }) {
  return <div><h1>{title}</h1>{children}</div>
}`
  writeFileSync(path.join(dir, 'Layout.tsx'), layoutSrc)
  
  const pageSrc = `import Layout from './Layout'
export default function Page({ greeting }) {
  return <Layout title={greeting} />
}`
  writeFileSync(path.join(dir, 'Page.tsx'), pageSrc)
  
  // routes entry (Page is a native route)
  const routesSrc = `import Page from './Page'
export const routes = [{ path: '/', Component: Page, native: true }]`
  writeFileSync(path.join(dir, 'routes.tsx'), routesSrc)
  
  const outDir = path.join(dir, 'jinja')
  mkdirSync(outDir)
  
  await emitNativeTemplates({
    entryFile: path.join(dir, 'routes.tsx'),
    flatRoutes: [{ nativeTemplate: 'Page' }],
    outDir,
    repoRoot: dir,
  })
  
  // .components.json must exist
  const compJson = path.join(outDir, 'Page.components.json')
  expect(existsSync(compJson)).toBe(true)
  const comps = JSON.parse(readFileSync(compJson, 'utf8'))
  expect(comps[0].component).toBe('Layout')
  expect(comps[0].sourcePath).toBeTruthy()
  
  // .factory.ts must exist
  const factoryTs = path.join(outDir, 'Page.factory.ts')
  expect(existsSync(factoryTs)).toBe(true)
  const factorySrc = readFileSync(factoryTs, 'utf8')
  expect(factorySrc).toContain("import Layout from")
  expect(factorySrc).toContain("export const factories")
  expect(factorySrc).toContain("h(Layout")
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd runtime && bun test cli/native-routes-emit.test.ts 2>&1 | grep -E "FAILED|error" | head -5
```

Expected: FAILED (functions not implemented yet).

- [ ] **Step 3: Add types and helpers to `native-routes-emit.ts`**

Add after the existing interfaces:

```typescript
/** Raw component entry from compileJsx (`componentsJson` field). */
interface RawComponentEntry {
  component: string
  instance: number
  factoryExpr: string
  referencedComponents: string[]
  usesIsland: boolean
}

/** Enriched component entry written to `<Name>.components.json`. */
interface EnrichedComponentEntry extends RawComponentEntry {
  sourcePath: string
}
```

- [ ] **Step 4: Add `emitComponentArtifacts` helper to `native-routes-emit.ts`**

Add before `emitNativeTemplates`:

```typescript
/** Write `<Name>.components.json` and `<Name>.factory.ts` for a native route
 * that has SSR components. Also scans each SSR component's source for any
 * `<Island component={X}` usage and returns their identifiers (so the island
 * chunk build step can include them). */
function emitComponentArtifacts(
  outPath: string,        // abs path to the .jinja file (used for sibling naming)
  componentsJsonStr: string,
  pageImports: Map<string, string>,
  routeName: string,
): { islandIdsFromComponents: string[] } {
  const raw = JSON.parse(componentsJsonStr) as RawComponentEntry[]
  if (raw.length === 0) return { islandIdsFromComponents: [] }

  // Enrich with sourcePaths
  const enriched: EnrichedComponentEntry[] = raw.map((entry) => {
    const sourcePath = pageImports.get(entry.component)
    if (!sourcePath) {
      throw new Error(
        `SSR component "${entry.component}" in native route "${routeName}" has no matching import in the page source`,
      )
    }
    return { ...entry, sourcePath }
  })

  // Write <Name>.components.json
  const compJsonPath = outPath.replace(/\.jinja$/, '.components.json')
  writeFileSync(compJsonPath, JSON.stringify(enriched))

  // Collect all import paths: SSR component sources + Island component sources
  const importLines: string[] = []
  const seen = new Set<string>()

  // Always import { Island } from brustjs if any factory uses islands
  const needsIsland = enriched.some((e) => e.usesIsland)
  if (needsIsland) {
    importLines.push("import { Island } from 'brustjs'")
    importLines.push("import { createElement as h } from 'react'")
  } else {
    importLines.push("import { createElement as h } from 'react'")
  }

  // Import each referenced component from its resolved source path
  const allReferenced = [...new Set(enriched.flatMap((e) => e.referencedComponents))]
  for (const compName of allReferenced) {
    if (seen.has(compName)) continue
    seen.add(compName)
    const srcPath = pageImports.get(compName)
    if (srcPath) {
      importLines.push(`import ${compName} from ${JSON.stringify(srcPath)}`)
    }
  }

  // Scan SSR component source files for <Island component={X}> — these
  // Island identifiers need their JS chunks built even though they don't
  // appear in the page's own .islands.json.
  const islandIdsFromComponents: string[] = []
  const islandScanRe = /data-brust-island|<Island\s+component=\{(\w+)\}/g
  const islandAttrRe = /<Island\s[^>]*component=\{(\w+)\}/g
  for (const entry of enriched) {
    try {
      const src = readFileSync(entry.sourcePath, 'utf8')
      let m: RegExpExecArray | null
      while ((m = islandAttrRe.exec(src)) !== null) {
        if (m[1] && !islandIdsFromComponents.includes(m[1])) {
          islandIdsFromComponents.push(m[1])
        }
      }
    } catch {
      // Source unreadable — skip
    }
  }

  // Write <Name>.factory.ts
  const factoryPath = outPath.replace(/\.jinja$/, '.factory.ts')
  const factoryLines = [
    '// Auto-generated by brust build — do not edit',
    ...importLines,
    '',
    'export const factories: Array<(ctx: any) => any> = [',
    ...enriched.map((e, i) => `  // comp_${i}: ${e.component}\n  ${e.factoryExpr},`),
    ']',
  ]
  writeFileSync(factoryPath, factoryLines.join('\n') + '\n')

  return { islandIdsFromComponents }
}
```

- [ ] **Step 5: Call `emitComponentArtifacts` from `emitNativeTemplates`**

In `emitNativeTemplates`, after writing the `.jinja` file and calling `reconcileIslandManifest`, add:

```typescript
const compJsonStr = compiled.componentsJson ?? '[]'
if (compJsonStr !== '[]') {
  emitComponentArtifacts(outPath, compJsonStr, pageImports, name)
}
```

Note: `compileJsx` now returns `componentsJson` — update the call-site type:

```typescript
let compiled: { template: string; islandsJson: string; componentsJson?: string }
```

- [ ] **Step 6: Run tests**

```bash
cd runtime && bun test cli/native-routes-emit.test.ts 2>&1 | tail -10
```

Expected: new tests pass.

- [ ] **Step 7: Run existing native-routes-emit tests to check no regression**

```bash
cd runtime && bun test cli/native-routes-emit 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add runtime/cli/native-routes-emit.ts runtime/cli/native-routes-emit.test.ts
git commit -m "feat(build): emit .components.json + .factory.ts for native SSR components"
```

---

### Task 7: `resolveComponentContext` in `native-render.ts`

**Files:**
- Modify: `runtime/islands/native-render.ts`
- Test: `runtime/islands/native-render.test.ts` (alongside existing tests)

- [ ] **Step 1: Write failing tests**

Add to `runtime/islands/native-render.test.ts` (or create it alongside existing `native-render.ts` tests):

```typescript
import { test, expect, mock } from 'bun:test'
import path from 'node:path'

// We test resolveComponentContext by providing a factory that renders a known component.
// Create a temp factory file for the test.
import { resolveComponentContext, loadComponentManifest } from './native-render.ts'

test('resolveComponentContext renders factory and returns comp_0_html', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(path.join(tmpdir(), 'brust-comp-resolve-'))

  // Write a minimal component and factory
  writeFileSync(path.join(dir, 'SimpleComp.tsx'), `
    import { createElement } from 'react'
    export default function SimpleComp({ label }) {
      return createElement('p', null, label)
    }
  `)
  writeFileSync(path.join(dir, 'TestPage.factory.ts'), `
    import { createElement as h } from 'react'
    import SimpleComp from '${path.join(dir, 'SimpleComp.tsx')}'
    export const factories = [
      (ctx) => h(SimpleComp, { label: ctx.greeting }),
    ]
  `)
  writeFileSync(path.join(dir, 'TestPage.components.json'), JSON.stringify([
    { component: 'SimpleComp', instance: 0, sourcePath: path.join(dir, 'SimpleComp.tsx') }
  ]))

  const manifest = loadComponentManifest('TestPage', dir)
  expect(manifest).not.toBeNull()
  expect(manifest![0].component).toBe('SimpleComp')

  const ctx = await resolveComponentContext(manifest!, { greeting: 'hello' }, 'TestPage', dir)
  expect(ctx.comp_0_html).toContain('hello')
  expect(ctx.comp_0_html).toContain('<p')
})

test('resolveComponentContext degrades to empty string on factory throw', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(path.join(tmpdir(), 'brust-comp-fail-'))

  writeFileSync(path.join(dir, 'FailPage.factory.ts'), `
    export const factories = [() => { throw new Error('boom') }]
  `)
  writeFileSync(path.join(dir, 'FailPage.components.json'), JSON.stringify([
    { component: 'Fail', instance: 0, sourcePath: '/nonexistent' }
  ]))

  const manifest = loadComponentManifest('FailPage', dir)
  const ctx = await resolveComponentContext(manifest!, {}, 'FailPage', dir)
  expect(ctx.comp_0_html).toBe('')
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd runtime && bun test islands/native-render 2>&1 | grep -E "FAILED|error" | head -5
```

Expected: FAILED (functions not exported yet).

- [ ] **Step 3: Add to `native-render.ts`**

Append after the existing exports:

```typescript
/** One entry in `<Name>.components.json` as enriched by `emitComponentArtifacts`. */
export interface NativeComponentEntry {
  component: string
  instance: number
  sourcePath: string
}

// Cache component manifests by absolute path (same pattern as island manifests).
const componentManifestCache = new Map<string, NativeComponentEntry[] | null>()

export function loadComponentManifest(
  templateName: string,
  jinjaDir?: string,
): NativeComponentEntry[] | null {
  const dir = jinjaDir ?? path.resolve(process.cwd(), '.brust/jinja')
  const abs = path.resolve(dir, `${templateName}.components.json`)
  if (componentManifestCache.has(abs)) return componentManifestCache.get(abs)!
  let parsed: NativeComponentEntry[] | null
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8')) as NativeComponentEntry[]
  } catch {
    componentManifestCache.set(abs, null)
    return null
  }
  componentManifestCache.set(abs, parsed)
  return parsed
}

// Cache factory modules by absolute path.
const factoryCache = new Map<string, { factories: Array<(ctx: unknown) => unknown> } | null>()

export async function resolveComponentContext(
  manifest: NativeComponentEntry[],
  data: unknown,
  templateName: string,
  jinjaDir?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!manifest.length) return out

  const dir = jinjaDir ?? path.resolve(process.cwd(), '.brust/jinja')
  const factoryPath = path.resolve(dir, `${templateName}.factory.ts`)

  let factoryMod = factoryCache.get(factoryPath)
  if (factoryMod === undefined) {
    try {
      factoryMod = await import(factoryPath) as { factories: Array<(ctx: unknown) => unknown> }
    } catch {
      factoryMod = null
    }
    factoryCache.set(factoryPath, factoryMod)
  }

  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i]!
    try {
      if (!factoryMod?.factories?.[i]) {
        throw new Error(`factory[${i}] not found in ${factoryPath}`)
      }
      const node = factoryMod.factories[i]!(data)
      out[`comp_${i}_html`] = renderToString(node as any)
    } catch (e) {
      console.error(
        `[brust] SSR component "${entry.component}" renderToString failed; degrading to empty:`,
        e,
      )
      out[`comp_${i}_html`] = ''
    }
  }
  return out
}
```

- [ ] **Step 4: Run tests**

```bash
cd runtime && bun test islands/native-render 2>&1 | tail -10
```

Expected: all pass (new + existing).

- [ ] **Step 5: Commit**

```bash
git add runtime/islands/native-render.ts
git commit -m "feat(runtime): resolveComponentContext — render SSR components via factory"
```

---

### Task 8: `routes.ts` wiring + integration test

**Files:**
- Modify: `runtime/routes.ts`
- Test: `tests/integration.test.ts` (add cases to existing shared-server suite)

- [ ] **Step 1: Write failing integration test**

In `tests/integration.test.ts`, inside the shared-server test block, add:

```typescript
test('GET /native-ssr-component returns Layout HTML without client JS for Layout', async () => {
  const res = await fetch(`http://localhost:${sharedPort()}/native-ssr-component`)
  expect(res.status).toBe(200)
  const html = await res.text()
  // Layout rendered server-side: its structural HTML must be present
  expect(html).toContain('<header')
  // No brust island bootstrap for Layout itself (it's not an island)
  // The page may still contain island bootstrap for Counter inside Layout
  expect(html).not.toContain('data-brust-island="Layout"')
})

test('GET /native-ssr-component Island inside Layout hydrates (markers present)', async () => {
  const res = await fetch(`http://localhost:${sharedPort()}/native-ssr-component`)
  const html = await res.text()
  // Counter Island markers must be present (client bootstrap will hydrate them)
  expect(html).toContain('data-brust-island="Counter"')
  expect(html).toContain('data-brust-props=')
})
```

Add the route to `tests/fixtures/app/routes.tsx` (the integration test app):

```typescript
import NativeSsrComponent from './pages/NativeSsrComponent'
// In defineRoutes:
{
  path: '/native-ssr-component',
  Component: NativeSsrComponent,
  native: true,
  loader: async () => ({
    greeting: 'Hello from SSR component',
    counter: { start: 0, label: 'clicks' },
  }),
},
```

Create `tests/fixtures/app/pages/NativeSsrComponent.tsx`:

```tsx
import Counter from '../components/Counter'
import { Island } from '../../../../runtime/index.ts'

function NativeLayout({ title, children }: { title: string; children: any }) {
  return (
    <div>
      <header><h1>{title}</h1></header>
      <main>{children}</main>
    </div>
  )
}

export default function NativeSsrComponent({ greeting, counter }: {
  greeting: string
  counter: { start: number; label: string }
}) {
  return (
    <NativeLayout title={greeting}>
      <Island component={Counter} props={counter} hydrate="load" />
    </NativeLayout>
  )
}
```

- [ ] **Step 2: Run integration test to confirm failure**

```bash
cd tests && bun test integration.test.ts -t "native-ssr-component" 2>&1 | grep -E "FAILED|error" | head -5
```

Expected: FAILED (routes not wired).

- [ ] **Step 3: Update `routes.ts` native branch**

In `runtime/routes.ts`, add the import at the top:

```typescript
import {
  loadComponentManifest,
  resolveComponentContext,
} from './islands/native-render.ts'
```

In the native branch (around line 610 after the island manifest logic), replace the existing island-only merge with a `Promise.all`:

```typescript
const manifest = loadIslandManifest(flat.nativeTemplate)
const compManifest = loadComponentManifest(flat.nativeTemplate)

const rt = JSON.parse(json) as Record<string, unknown>

if ((manifest && manifest.length > 0) || (compManifest && compManifest.length > 0)) {
  const [islandExtra, componentExtra] = await Promise.all([
    manifest && manifest.length > 0
      ? resolveIslandContext(manifest, rt, islandCache)
      : Promise.resolve({} as Record<string, string>),
    compManifest && compManifest.length > 0
      ? resolveComponentContext(compManifest, rt, flat.nativeTemplate)
      : Promise.resolve({} as Record<string, string>),
  ])
  const ctx = { ...rt, ...islandExtra, ...componentExtra }
  const finalBytes = encoder.encode(JSON.stringify(ctx))
  if (finalBytes.length > view.length) {
    return packSingleChunkResponse(view, encoder, {
      status: 413,
      contentType: 'text/plain; charset=utf-8',
      body: 'loader data too large for SAB',
    })
  }
  view.set(finalBytes, 0)
  try {
    return (native as any).napiRenderJinja(
      Number(workerId),
      finalBytes.length,
      flat.nativeTemplate,
    )
  } catch (err) {
    console.error(`[brust] napiRenderJinja failed for "${flat.nativeTemplate}":`, err)
    return packSingleChunkResponse(view, encoder, {
      status: 500,
      contentType: 'text/html; charset=utf-8',
      body: 'internal error',
    })
  }
}
```

- [ ] **Step 4: Build the integration test app**

```bash
cd tests && bun run build 2>&1 | tail -10
```

Expected: build succeeds, `.brust/jinja/NativeSsrComponent.jinja` + `.components.json` + `.factory.ts` emitted.

- [ ] **Step 5: Run integration tests**

```bash
cd tests && bun test integration.test.ts 2>&1 | tail -15
```

Expected: all integration tests pass including new `native-ssr-component` cases.

- [ ] **Step 6: Run full test baselines**

```bash
cargo test --workspace 2>&1 | tail -3
bun test runtime/ 2>&1 | tail -3
cd tests && bun test native-island.test.ts native-island-ssr.test.ts integration.test.ts 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add runtime/routes.ts \
        tests/integration.test.ts \
        tests/fixtures/app/routes.tsx \
        tests/fixtures/app/pages/NativeSsrComponent.tsx
git commit -m "feat(runtime): wire resolveComponentContext in native route dispatch + integration test"
```

---

## Self-Review

### Spec coverage

| Spec section | Task |
|---|---|
| `JsxNode::SsrComponent` IR node | Task 1 |
| `ComponentMeta` + `Compiled.components` | Task 1 |
| `number_ssr_components` + `collect_components` | Task 1 |
| `collect_islands` skips `SsrComponent.children` | Task 1 |
| Dedicated camelCase-safe attr loop (`lower_ssr_component`) | Task 2 |
| Third recognition path in `lower_element` | Task 2 |
| `emit_jinja` `{{ comp_N_html \| safe }}` | Task 3 |
| `emit_factory` `(ctx) => h(…)` expression | Task 4 |
| `referenced_components` + `uses_island` | Task 4 |
| NAPI `components_json` field | Task 5 |
| TS: `.components.json` + `.factory.ts` | Task 6 |
| Island scan in SSR component sources | Task 6 |
| `resolveComponentContext` + `loadComponentManifest` | Task 7 |
| Contained failure (empty string + log) | Task 7 |
| `Promise.all([island, component])` in routes.ts | Task 8 |
| 413 guard on merged ctx | Task 8 |
| Integration test (Island inside SSR component hydrates) | Task 8 |
| `infer_props_types` opaque arm | Task 1 (Step 5) |

### Type consistency

- `FactoryOutput.expr` / `ComponentMeta.factory_expr` — matched Task 1↔4
- `NativeComponentEntry` fields match `components.json` shape from Task 6
- `resolveComponentContext` signature matches usage in Task 8
- `loadComponentManifest` returns `NativeComponentEntry[] | null` — matched Task 7↔8

### Known limitations (stated in spec)

- Islands inside SSR components do not benefit from ISR caching (by design)
- `native` attribute is reserved but not implemented (follow-on spec)
- Island chunk discovery in SSR component sources is regex-based + one-level (not recursive)
- SSR component `renderToString` runs per-request (no caching in this phase)
