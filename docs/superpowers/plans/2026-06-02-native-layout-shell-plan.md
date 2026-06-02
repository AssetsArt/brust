# Implementation plan — native layout shell

**Spec:** `docs/superpowers/specs/2026-06-02-native-layout-shell-design.md`
**Branch:** `feat/native-layout-shell`
**Base:** main `8f7806f` (post #22)

## Spec coverage table

| Spec section | Task |
|---|---|
| Change 1 — document-root inline (seam pinned) | T1 |
| Change 2 — head-prop subst (`StaticText → Literal`) | T1 |
| Change 3 — children splice (no-op) | T1 (assert only) |
| Compiler tests 1–7 | T1 |
| napi rebuild | T2 |
| `PageLayout.tsx` + 3 page refactors | T2 |
| `FRAMEWORK-GAPS.md` update | T2 |
| Dogfood curl (4 checks) + regression suites | T3 |
| Acceptance criteria (fmt/clippy/biome/tests) | T1 (rust gates), T3 (ts gates + dogfood) |

## Recommended seam (resolves spec Change-1 open question)

Thread a `doc_root: bool` ONLY through `lower_ssr_component → try_native_inline → lower_component_inline`. `lower_element`'s **signature is unchanged** — its internal call to `lower_ssr_component` (lower.rs ~566) just passes `false`. The route-root promotion is enabled by `lower_with_sources` calling `lower_ssr_component(element, name, &scope, false, /*doc_root=*/true)` **directly** for a capitalized custom-component root (a new branch in the root `match`, bypassing `lower_element` for that one case). Inside `lower_component_inline`, when `doc_root == true` AND the body's single-return root element ident is `BrustPage`, call `lower_brust_page(el, &scope)` (under the inline scope) instead of `lower_element`.

This keeps the blast radius to four functions + one test helper, leaves `lower_element` rejecting nested `<BrustPage>` everywhere, and makes the nested `try_native_inline` path pass `doc_root=false` so a layout used below the root never promotes.

**BLOCKED fallback:** if the direct `lower_ssr_component` call from `lower_with_sources` collides with `in_map`/`SsrComponentInMap` or the SSR-fallback rebuild, pivot to seam (a): a dedicated `lower_root_native_component` helper in `lower_with_sources` that replicates the native-branch attr loop (subst + children) and calls the inline core with `doc_root=true`. Same observable behavior; more code. Do NOT thread the bool through `lower_element`'s signature.

---

## T1 — Compiler: document-root inline + head-prop subst (TDD)

**File:** `crates/jsx-rust-compiler/src/lower.rs` only.

### Step 1.1 — Write the 7 tests FIRST (red)

Add to the `#[cfg(test)] mod tests` block (near the other inline tests, ~line 4600). Helper to build a one-entry sources map + lower a route:

```rust
fn lower_route_with_layout(route_src: &str, layout_name: &str, layout_src: &str) -> (Component, Vec<String>) {
    let parsed = parse(route_src, "<route>").unwrap();
    let mut sources = HashMap::new();
    sources.insert(layout_name.to_string(), layout_src.to_string());
    super::lower_with_sources(&parsed, sources).unwrap()
}

const SHELL_LAYOUT: &str = r#"export default function PageLayout({ title, crumb, children }: any) {
  return (
    <BrustPage lang="en" className="dark" title={title}>
      <main><b>{crumb}</b><div className="aa-content">{children}</div></main>
    </BrustPage>
  );
}"#;
```

1. **`native_layout_root_promotes_to_document`** — route passes a string-literal title:
```rust
#[test]
fn native_layout_root_promotes_to_document() {
    let route = r#"export default function Page(d: any) {
  return <PageLayout native title="T" crumb="C"><p>hi</p></PageLayout>;
}"#;
    let (c, _w) = lower_route_with_layout(route, "PageLayout", SHELL_LAYOUT);
    match &c.root {
        JsxNode::Document { title, lang, .. } => {
            assert_eq!(title.as_ref(), Some(&crate::ir::HeadValue::Literal("T".to_string())));
            assert_eq!(lang.as_ref(), Some(&crate::ir::HeadValue::Literal("en".to_string())));
        }
        other => panic!("expected Document, got {other:?}"),
    }
}
```

2. **`native_layout_head_prop_via_member_path`** — route passes `title={pageTitle}` (bare ident → `Field`):
```rust
#[test]
fn native_layout_head_prop_via_member_path() {
    let route = r#"export default function Page({ pageTitle }: any) {
  return <PageLayout native title={pageTitle} crumb="C"><p>hi</p></PageLayout>;
}"#;
    let (c, _w) = lower_route_with_layout(route, "PageLayout", SHELL_LAYOUT);
    match &c.root {
        JsxNode::Document { title: Some(crate::ir::HeadValue::Path(crate::ir::Expr::Field(f))), .. } => {
            assert_eq!(f, "pageTitle");
        }
        other => panic!("expected Document title Path(Field), got {other:?}"),
    }
    // emit-level: jinja escapes the head path
    let mut sources = HashMap::new();
    sources.insert("PageLayout".to_string(), SHELL_LAYOUT.to_string());
    let out = super::super::compile_full(route, "<route>", sources).unwrap();
    assert!(out.template.contains("{{ pageTitle | e }}"), "template was: {}", out.template);
}
```
> NOTE: confirm the `compile_full` path at impl time — it is `crate::compile_full` (lib.rs). Inside the test module use the correct path (`super::super::compile_full` or `crate::compile_full`).

3. **`native_layout_splices_children_into_shell`** — `{children}` replaced by `<p>hi</p>` in the Document body:
```rust
#[test]
fn native_layout_splices_children_into_shell() {
    let route = r#"export default function Page(d: any) {
  return <PageLayout native title="T" crumb="C"><p>hi</p></PageLayout>;
}"#;
    let (c, _w) = lower_route_with_layout(route, "PageLayout", SHELL_LAYOUT);
    // Walk Document.body → main → find the aa-content div → assert it holds <p>, not a ChildrenSlot.
    let JsxNode::Document { body, .. } = &c.root else { panic!("expected Document") };
    let found_p = format!("{body:?}").contains("\"p\"") && !format!("{body:?}").contains("ChildrenSlot");
    assert!(found_p, "children not spliced: {body:?}");
}
```

4. **`nested_brustpage_literal_still_rejected`** (regression guard):
```rust
#[test]
fn nested_brustpage_literal_still_rejected() {
    let src = r#"export default function Page(d: any) {
  return <div><BrustPage title="x"/></div>;
}"#;
    let parsed = parse(src, "<test>").unwrap();
    let err = lower(&parsed).unwrap_err();
    assert!(matches!(err.kind, ErrorKind::BrustPageMustBeRoot), "got {:?}", err.kind);
}
```

5. **`native_layout_below_root_does_not_promote`** — layout that roots in `<BrustPage>` used inside a `<div>` must NOT become a Document; no `JsxNode::Document` below root:
```rust
#[test]
fn native_layout_below_root_does_not_promote() {
    let route = r#"export default function Page(d: any) {
  return <div><PageLayout native title="T" crumb="C"><p>hi</p></PageLayout></div>;
}"#;
    let parsed = parse(route, "<route>").unwrap();
    let mut sources = HashMap::new();
    sources.insert("PageLayout".to_string(), SHELL_LAYOUT.to_string());
    let result = super::lower_with_sources(&parsed, sources);
    // Either a hard reject (BrustPageMustBeRoot) OR a soft SSR fallback — but
    // NEVER a Document node anywhere in the tree.
    match result {
        Err(e) => assert!(matches!(e.kind, ErrorKind::BrustPageMustBeRoot), "got {:?}", e.kind),
        Ok((c, _w)) => assert!(!format!("{:?}", c.root).contains("Document"), "must not promote below root: {:?}", c.root),
    }
}
```

6. **`native_layout_rooting_in_element_unchanged`** — a `native` root component that roots in a normal element produces an element root, not a Document (T6 regression):
```rust
#[test]
fn native_layout_rooting_in_element_unchanged() {
    let route = r#"export default function Page(d: any) {
  return <Wrap native label="hi"><p>x</p></Wrap>;
}"#;
    let wrap = r#"export default function Wrap({ label, children }: any) {
  return <section><h1>{label}</h1>{children}</section>;
}"#;
    let (c, _w) = lower_route_with_layout(route, "Wrap", wrap);
    assert!(matches!(c.root, JsxNode::Element { .. }), "expected Element root, got {:?}", c.root);
}
```

7. **`native_layout_active_conditional_element`** — conditional element with string-literal compare inside the inlined layout lowers to `JsxNode::Cond`:
```rust
#[test]
fn native_layout_active_conditional_element() {
    let route = r#"export default function Page(d: any) {
  return <Nav native active="list"/>;
}"#;
    let nav = r#"export default function Nav({ active }: any) {
  return <nav>{active === 'list' ? <a className="is-active">L</a> : <a>L</a>}</nav>;
}"#;
    let (c, _w) = lower_route_with_layout(route, "Nav", nav);
    // The <nav> root element's child is a Cond.
    let JsxNode::Element { children, .. } = &c.root else { panic!("expected Element, got {:?}", c.root) };
    assert!(children.iter().any(|ch| matches!(ch, JsxNode::Cond { .. })), "no Cond in {children:?}");
}
```

**Run (expect 7 failures / compile errors against current code):**
```
cargo test -p jsx-rust-compiler native_layout 2>&1 | tail -20
cargo test -p jsx-rust-compiler nested_brustpage 2>&1 | tail -5
```
> Test 4 (`nested_brustpage_literal_still_rejected`) should already PASS (guards existing behavior). Tests 1,2,3,5(Ok-branch),7 fail until impl; 6 should pass already (existing T6).

### Step 1.2 — Implement (green)

Edit `lower.rs`:

a. **`lower_component_inline`** (signature ~220, body-root lowering ~247): add param `doc_root: bool`. At the single-return JSX branch, before `lower_element(el, &scope, false)`:
```rust
SwcExpr::JSXElement(el) => {
    if doc_root
        && let JSXElementName::Ident(ident) = &el.opening.name
        && ident.sym.as_ref() == "BrustPage"
    {
        return Ok(vec![lower_brust_page(el, &scope)?]);
    }
    let node = lower_element(el, &scope, false)?;
    return Ok(vec![node]);
}
```
(The two-statement `if/return` body path stays unchanged — a layout shell is single-return.)

b. **`try_native_inline`** (~1080): add param `doc_root: bool`; pass to `lower_component_inline(&parsed_comp, subst, has_children, Some(env.clone()), doc_root)` (~1164).

c. **`lower_ssr_component`** (~742): add param `doc_root: bool`; pass to the `try_native_inline(...)` call (~875). The non-native / SSR-fallback paths ignore it.

d. **`lower_element`** call to `lower_ssr_component` (~566): pass `false` (nested → never doc root). Signature of `lower_element` unchanged.

e. **`lower_with_sources`** root `match` (~178-186): add a branch for a capitalized custom component carrying `native`, calling `lower_ssr_component` directly with `doc_root=true`:
```rust
SwcExpr::JSXElement(element) => {
    if let JSXElementName::Ident(ident) = &element.opening.name {
        let s = ident.sym.as_ref();
        if s == "BrustPage" {
            lower_brust_page(element, &scope)?
        } else if s == "Island" {
            lower_element(element, &scope, false)?   // Island stays via lower_element
        } else if s.starts_with(|c: char| c.is_ascii_uppercase())
            && has_native_attr(element)
        {
            lower_ssr_component(element, s, &scope, false, /*doc_root=*/true)?
        } else {
            lower_element(element, &scope, false)?
        }
    } else {
        lower_element(element, &scope, false)?
    }
}
```
Add a tiny helper `fn has_native_attr(el: &JSXElement) -> bool` mirroring the `has_native` closure at ~763 (bare `native` attr present). If a non-native capitalized root (or unresolved source) → it flows through `lower_ssr_component`'s soft-fallback exactly as today.

f. **`lower`** (~116, the `#[allow(dead_code)]` entry): its custom-root path goes through `lower_element` (no `inline_env`), so doc-root never triggers there — leave as-is. Only update its internal `lower_ssr_component` call site if the signature change requires it (it routes via `lower_element`, so no direct call — no change).

g. **`lower_brust_page`** (~680-692): add the `StaticText → Literal` arm inside the `JSXExprContainer` `lower_expr` match:
```rust
match lower_expr(e, scope) {
    Ok(ex @ (crate::ir::Expr::Field(_) | crate::ir::Expr::MemberAccess { .. })) => {
        *slot = Some(crate::ir::HeadValue::Path(ex));
    }
    Ok(crate::ir::Expr::StaticText(s)) => {
        *slot = Some(crate::ir::HeadValue::Literal(s));
    }
    _ => return Err(LowerError::at(jsx_attr.span, ErrorKind::BrustPageAttrMustBeStringLiteral(name))),
}
```

h. **Test helper** `inline_lower` (~4603-4610): update the `lower_component_inline(&parsed, subst, has_children, None)` call to pass `false` for `doc_root`.

**Run (expect green):**
```
cargo test -p jsx-rust-compiler 2>&1 | tail -15            # all crate tests, incl. 7 new
cargo fmt --all -- --check
cargo clippy -p jsx-rust-compiler --all-targets --locked -- -D warnings 2>&1 | tail -10
```
Expected: `test result: ok.` with the 7 new tests passing; fmt clean; clippy 0 warnings.

**ESCALATE if:** the doc_root threading breaks ≥3 existing crate tests in ways not explained by the signature change, OR `lower_brust_page` under inline scope does not resolve `{title}` via subst (verify `lower_expr` subst path at ~2614). Second failure on the same root cause → orchestrator calls advisor.

---

## T2 — napi rebuild + PageLayout.tsx + page refactors + GAPS

**Depends on T1 green.**

### Step 2.1 — Rebuild the napi addon (REQUIRED — memory `stale-napi-node-after-compiler-change`)
```
cd runtime && bun run build 2>&1 | tail -5   # release .node; build:debug is ~2× slower
```
Expect a successful native build (`runtime/brust.<platform>.node` regenerated). Without this, `brust build` uses the OLD binary and rejects the new construct.

### Step 2.2 — Create `example/pokedex/components/PageLayout.tsx`

Single-return, no local bindings (spec F3). Owns the shell + sidebar + topbar + TeamBuilder island:

```tsx
// Shared native layout shell. INLINED into each route at build time (T6): the
// route's root is <PageLayout native …>, whose expansion roots in <BrustPage>,
// which the compiler now promotes to the document shell. Pages supply only
// title/active/crumb + their aa-content inner.
//
// MUST stay single-return with no local bindings above it — a local `const`
// would make the compiler soft-fall-back to an SSR component (no <html> shell).
// active-nav uses conditional ELEMENTS (S11), not a className ternary
// (unsupported). See ../FRAMEWORK-GAPS.md.
import { BrustPage, Island } from '../../../runtime/index.ts'
import TeamBuilder from './TeamBuilder'

export default function PageLayout({
  title,
  active,
  crumb,
  teamProps,
  children,
}: {
  title: string
  active: 'list' | 'typechart'
  crumb: string
  teamProps: unknown
  children: unknown
}) {
  return (
    <BrustPage lang="en" className="dark" title={title}>
      <div className="aa-app">
        <aside className="aa-sidebar">
          <div className="aa-sidebar__brand">
            <div className="aa-sidebar__brand-mark">P</div>
            <div className="grow truncate">
              <div className="aa-sidebar__brand-name">PokéDex</div>
              <div className="aa-sidebar__brand-sub">brust example app</div>
            </div>
            <span className="aa-sidebar__env">native</span>
          </div>
          <nav className="aa-sidebar__nav">
            <div className="aa-sidebar__group-title">Pokédex</div>
            {active === 'list' ? (
              <a className="aa-nav-item is-active" href="/">
                <span>All Pokémon</span>
              </a>
            ) : (
              <a className="aa-nav-item" href="/">
                <span>All Pokémon</span>
              </a>
            )}
            {active === 'typechart' ? (
              <a className="aa-nav-item is-active" href="/type-chart">
                <span>Type chart</span>
                <span className="aa-nav-item__count">native</span>
              </a>
            ) : (
              <a className="aa-nav-item" href="/type-chart">
                <span>Type chart</span>
                <span className="aa-nav-item__count">native</span>
              </a>
            )}
          </nav>
          <div className="aa-sidebar__user">
            <span className="aa-avatar aa-avatar--sm dex-brand-avatar">B</span>
            <div className="grow truncate dex-user">
              <div className="dex-user__name">brust dev</div>
              <div className="dex-user__host">localhost</div>
            </div>
          </div>
        </aside>

        <main className="aa-main">
          <header className="aa-topbar">
            <div className="aa-topbar__crumb">
              <a href="/" className="dex-crumb__root">
                PokéDex
              </a>
              <span className="dex-crumb__sep">›</span>
              <b>{crumb}</b>
            </div>
          </header>

          <div className="aa-content">{children}</div>
        </main>

        <Island component={TeamBuilder} props={teamProps} ssr hydrate="load" />
      </div>
    </BrustPage>
  )
}
```

### Step 2.3 — Refactor the 3 pages

Each page: drop the `<BrustPage>` + `aa-app` + sidebar + `aa-main`/topbar wrapper + the trailing `<Island TeamBuilder>`; return `<PageLayout native …>{inner}</PageLayout>` wrapping ONLY the former `aa-content` inner. Keep all loader-prop destructuring and inner content verbatim.

- **`pages/ListPage.tsx`** — imports become `PageLayout` + types (drop `BrustPage`/`Island`/`TeamBuilder`). Return:
```tsx
return (
  <PageLayout native title="PokéDex · brust example" active="list" crumb="All Pokémon" teamProps={teamProps}>
    <div className="aa-page-header"> … </div>
    <div className="aa-alert …"> … </div>
    <div className="dex-grid"> {items.map(...)} </div>
    <div className="dex-pager"> … </div>
  </PageLayout>
)
```
(The former `aa-content` `<div>` is replaced by PageLayout's own `aa-content` — so its DIRECT children become PageLayout's children. Do NOT keep a second `aa-content` wrapper.)

- **`pages/DetailPage.tsx`** — imports: `PageLayout` + `Island` + `AddToTeamButton` + types (AddToTeamButton island stays in the hero content; drop `BrustPage`/`TeamBuilder`). Return:
```tsx
return (
  <PageLayout native title={pageTitle} active="list" crumb={displayName} teamProps={teamProps}>
    <a className="aa-btn aa-btn--ghost aa-btn--sm dex-back" href="/">‹ Pokédex</a>
    {notFound ? ( … ) : ( <> … hero (with <Island AddToTeamButton/>) … detail-right … evolution … </> )}
  </PageLayout>
)
```

- **`pages/TypeChart.tsx`** — imports: `PageLayout` + types (drop `BrustPage`/`Island`/`TeamBuilder`). `active="typechart"`, `crumb="Type chart"`, `title="PokéDex · type chart"`; inner = the page-header + legend + `dex-tc-scroll`.

### Step 2.4 — Update `example/pokedex/FRAMEWORK-GAPS.md`
Mark the native-layout / chrome-duplication gap ✅ FIXED (component-composition form via inlined `<PageLayout>` owning the `<BrustPage>` shell). Keep router-level `<Outlet>` noted as still-open. Update the status-summary block at top if present.

### Step 2.5 — Build the example + lint
```
bun run runtime/cli/index.ts build example/pokedex/index.ts 2>&1 | tail -20
bun run ci 2>&1 | tail -3   # biome
```
Expect: build succeeds (native templates compiled, no `path unsupported` / inline-fallback warnings about PageLayout); biome clean.

**ESCALATE if:** `brust build` warns `native component "PageLayout" not inlined: …` (means it soft-fell-back to SSR — the shell would be lost). Reproduce, read the warning reason, debug-mantra before pivoting. A `local binding` reason → PageLayout has a stray `const`; an `untranslatable` reason → an unsupported construct in the shell body.

---

## T3 — Dogfood (empirical) + regression suites

**Depends on T2.** Boot pokedex on a FRESH port (island cache per memory) and `curl`.

```
BRUST_PORT=3199 bun run example/pokedex/index.ts &   # background; wait for listen
# / : chrome present, active=list, title, island
curl -s 127.0.0.1:3199/ | grep -o 'aa-sidebar\|is-active[^"]*All\|<title>[^<]*</title>\|data-brust-island="TeamBuilder"' | sort -u
# /pokemon/pikachu : dynamic title + 2 islands + active=list
curl -s 127.0.0.1:3199/pokemon/pikachu | grep -o '<title>[^<]*</title>\|data-brust-island="\(TeamBuilder\|AddToTeamButton\)"\|is-active'
# bad name : notFound branch still renders (HTTP 200 body, S9 unchanged)
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3199/pokemon/zzznotreal ; curl -s 127.0.0.1:3199/pokemon/zzznotreal | grep -o 'dex-notfound\|404'
# /type-chart : active=typechart + title
curl -s 127.0.0.1:3199/type-chart | grep -o '<title>[^<]*</title>\|is-active[^"]*Type'
```
**Assert with eyes on output:**
- `/` → `<title>PokéDex · brust example</title>`, sidebar present, `is-active` on All Pokémon link, TeamBuilder island div present.
- `/pokemon/pikachu` → `<title>` contains the pokémon name (dynamic `pageTitle`), both TeamBuilder + AddToTeamButton island divs present, `is-active` on All Pokémon.
- bad name → HTTP 200 + `dex-notfound` present (unchanged S9).
- `/type-chart` → `<title>PokéDex · type chart`, `is-active` on Type chart.

Kill the server.

### Regression
```
bun test tests/cli-build.test.ts 2>&1 | tail -5        # expect 8 pass
bun test tests/integration.test.ts 2>&1 | tail -5       # expect 73 pass
```

**ESCALATE if:** any chrome/active/title assertion is absent in the curl output (means inline promotion silently degraded) — debug-mantra: confirm the emitted `.brust/jinja/*.jinja` actually contains the shell, before pivoting.

---

## Done = all green

- T1: 7 new + full `jsx-rust-compiler` crate green; fmt + clippy clean.
- T2: `.node` rebuilt; pokedex builds; biome clean; GAPS updated.
- T3: 4 curl checks pass (eyes on); cli-build 8/8; integration 73/73.
- Diff confined to `crates/jsx-rust-compiler/src/lower.rs` + `example/pokedex/**` + spec/plan. No `crates/brust/src/` or TS-runtime changes.
