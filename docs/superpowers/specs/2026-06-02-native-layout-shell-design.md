# Native layout shell — `<BrustPage>` owned by an inlined layout component

**Date:** 2026-06-02
**Status:** approved (brainstorm), pending plan
**Scope:** `crates/jsx-rust-compiler/` (compiler) + `example/pokedex/` (dogfood)
**Closes gap:** Cluster C "native layout/`<Outlet>` (chrome duplicated across 3 pages)" — partial: the **component-composition** form, not router-level `<Outlet>`.

## Goal

Let a `native: true` route's root be a **custom inlined component that itself returns `<BrustPage>`**, so the document shell (`<html>`/`<head>`/`<body>`) + shared chrome can live in ONE `PageLayout` component instead of being copy-pasted into every page.

Concretely, this must compile and render identically to today's hand-duplicated pages:

```tsx
// route component (e.g. ListPage)
export default function ListPage(data) {
  return (
    <PageLayout native title="PokéDex · brust example" active="list" crumb="All Pokémon" teamProps={data.teamProps}>
      {/* aa-content inner only */}
    </PageLayout>
  )
}

// components/PageLayout.tsx — inlined via T6, OWNS the shell
export default function PageLayout({ title, active, crumb, teamProps, children }) {
  return (
    <BrustPage lang="en" className="dark" title={title}>
      <div className="aa-app">…sidebar (active-driven)…<main>…<b>{crumb}</b>…<div className="aa-content">{children}</div></main>…
        <Island component={TeamBuilder} props={teamProps} ssr hydrate="load" />
      </div>
    </BrustPage>
  )
}
```

## Non-goals (out of scope — be loud)

- **Router-level `<Outlet>` / nested-route layouts.** This is component composition (one page wraps itself in a layout), NOT a router feature where the framework injects child routes into a parent layout. That remains an open Cluster C gap.
- **Multiple `<BrustPage>` per route**, fragments-as-document-root, or `<BrustPage>` appearing at any non-root position. All still rejected with `BrustPageMustBeRoot`.
- **Layout nesting** (a layout component that wraps another layout component that owns the shell). One level: route-root component → `<BrustPage>`. Deeper shell ownership is out of scope.
- **Non-native (SSR-React-path) layout sharing.** This is the native/jinja path only.
- **No runtime (`crates/brust/src/`) or TS-runtime changes.** Compiler + example only.

## Background — why it doesn't work today

`crates/jsx-rust-compiler/src/lower.rs`:

- `lower_with_sources` (route entry, line ~177) recognizes `<BrustPage>` **only when it is the literal root element** of the route component's single `return`. It dispatches that one ident to `lower_brust_page` → `JsxNode::Document`. Any other root goes to `lower_element`.
- `lower_element` (line ~556) rejects any `<BrustPage>` it sees as nested → `ErrorKind::BrustPageMustBeRoot`.

So `<PageLayout native>` as the route root takes the `else` branch → `lower_ssr_component` → `try_native_inline` → `lower_component_inline`, which lowers PageLayout's body. That body's root `<BrustPage>` reaches `lower_element` (nested path) and is rejected. **The shell can never be emitted from inside an inlined component.**

## High-level architecture

Add a **document-root inline** path: when the route root is a `native` custom component whose inline expansion's root element is `<BrustPage>`, route that root through `lower_brust_page` (yielding `JsxNode::Document`) instead of rejecting — and resolve the shell's head props through the inline substitution map so `title={title}` (a `PageLayout` prop) maps to the route call-site value.

Three coordinated compiler changes; the example refactor rides on top.

### Change 1 — document-root inline (lower.rs)

**Seam (pinned per spec review B1/F2):** the `<BrustPage>`-as-document promotion is gated at the **`lower_with_sources` route-root dispatch** via a **dedicated path** — NOT inside `lower_element` (its signature stays untouched; it keeps rejecting any `<BrustPage>` it sees) and NOT inside the shared `lower_component_inline` when reached via the nested `try_native_inline` path. Concretely: a `doc_root_allowed` capability is true ONLY on the route-root inline; the nested `try_native_inline` → `lower_component_inline` call passes it false, so a layout used below the root still hits `BrustPageMustBeRoot`. Implementation may either (a) add a dedicated `lower_root_native_component` helper in `lower_with_sources` that reuses `try_native_inline`'s resolve/parse/analyze/cycle/splice core with `doc_root_allowed=true`, or (b) thread a `doc_root_allowed: bool` only through the `try_native_inline`/`lower_component_inline` pair (default false; true only for the route-root call). Plan picks one after reading the seam. `lower_element` is NOT modified either way.

In `lower_with_sources`, when the route-root JSX is a capitalized custom component (not `Island`, not literal `BrustPage`) carrying a bare `native` attribute, take this **root-inline** path rather than the generic `lower_element`:

- Build the `subst` map from the call-site attributes exactly as `lower_ssr_component`'s native branch does (title/lang/className/active/crumb/teamProps → `Expr`; reject spreads/JSX-in-attr the same way). `native` and `key` attrs are skipped (dropped, not subst'd), as in the existing native branch (lower.rs ~816). **`isr` on the route-root layout component is out of scope (spec review F4/OQ3):** it is ignored with a warning, consistent with `try_native_inline`'s "isr ignored on inlined native component" (lower.rs ~1208). Documented under Known limitations.
- Resolve + parse the component source from `InlineEnv.sources` (reuse `try_native_inline`'s resolve/parse/analyze/cycle steps).
- Lower the component body under an inline scope (`InlineCtx { subst }`), but with a **"document root permitted"** signal so that **iff** the body's single-return root element is `<BrustPage>`, it is lowered via `lower_brust_page` (under the inline scope) → `JsxNode::Document`.
- Splice call-site children into `ChildrenSlot`s (`splice_children_slots` already handles `JsxNode::Document`, line ~1255 — no change there).
- If the component does NOT root in `<BrustPage>` (it roots in a normal element), the existing inline behavior is unchanged — it still produces a normal element root. (i.e. the new path is permissive, not mandatory.)
- Soft-fallback semantics preserved: if the component source is unresolved / un-analyzable / spread-tainted, fall back to the existing SSR-component emission with a warning (same as `try_native_inline` today). A `native`-marked root component that fails to inline does NOT silently lose its shell — it produces the same diagnostic/warning as any other failed native inline.

The "document root permitted" signal is scoped to the **route-root inline only**. A `<BrustPage>` reached during a *nested* inline (a `native` component used inside an element, or a layout used below the root) keeps the `BrustPageMustBeRoot` rejection. Implementation may thread a boolean through the root-inline helper rather than the generic recursion, to keep the blast radius small.

### Change 2 — head props via subst (lower.rs `lower_brust_page`)

`lower_brust_page` reads head props (`title`/`description`/`lang`/`className`/`bodyClassName`) and today accepts only:
- a string-literal JSX attr (`title="…"`) → `HeadValue::Literal`, or
- an expr container that lowers to `Expr::Field` / `Expr::MemberAccess` (`title={d.x}`) → `HeadValue::Path`.

Under the document-root inline, the head prop is written as `title={title}` inside `PageLayout`, where `title` is a `PageLayout` prop. Lowering `{title}` under the inline scope resolves it through `subst` to the call-site `Expr`, which is one of:
- `Expr::StaticText(s)` — when the page passed a string literal (`title="PokéDex · brust example"`). **NEW:** accept `Expr::StaticText(s)` → `HeadValue::Literal(s)`.
- `Expr::Field` / `Expr::MemberAccess` — when the page passed a loader path (`title={pageTitle}`). Already → `HeadValue::Path` (unchanged).

**Exact match-arm location (pinned per spec review B2):** the new `StaticText → Literal` arm goes ONLY inside the `JSXAttrValue::JSXExprContainer` branch's `lower_expr(e, scope)` result match (lower.rs ~680-692), alongside the existing `Field | MemberAccess` arm. The separate `JSXAttrValue::Str(s)` branch (~668-671, for a literal written directly on the tag) is already correct and is NOT touched — the `StaticText` shape only arises because inline subst has already converted the `{title}` container into a resolved `Expr`.

Any other resolved shape (arith, call, etc.) keeps the existing `BrustPageAttrMustBeStringLiteral` rejection. This single added match arm (`StaticText` → `Literal`) is the only behavioral change in `lower_brust_page`; the literal/path branches are unchanged. (Escaping is unchanged — head paths still emit `{{ path | e }}` per `brust-jinja-autoescape-none`; `HeadValue::Literal` is pre-escaped at emit by `push_html_escaped`/`push_attr_escaped`, so there is no double-escape and no path divergence between the `Str` and `StaticText` origins.)

**Note — `infer_props_types` / `props.types` is NOT load-bearing here (spec review B3 falsified):** `compile_full` returns the emitted jinja template + island/component manifests; it does not emit any Rust struct from `props.types`/`props.bindings`, and `emit_jinja` reads neither. Native routes render via minijinja with the loader's return as the dynamic scope (`{{ pageTitle | e }}` resolves at runtime). The `Document` arm of `infer_props_types` (lower.rs ~3056) walking only `body` and not the `HeadValue` fields is therefore pre-existing and harmless — DetailPage already ships `<BrustPage title={pageTitle}>` (S8, in `0.1.13-alpha`) with `pageTitle` referenced nowhere in its body, and it builds and runs. No change to `infer_props_types` is required or in scope.

### Change 3 — none for children

`splice_children_slots` already recurses into `JsxNode::Document { body, .. }` (lower.rs ~1255), so `{children}` inside the `<BrustPage>` body splices correctly with no change.

### Example refactor (`example/pokedex/`)

- **New** `components/PageLayout.tsx` — the inlined shell+chrome component (props `title`, `active: 'list' | 'typechart'`, `crumb`, `teamProps`, `children`). Active-nav uses S11 conditional **elements** (`{active === 'list' ? <a is-active/> : <a/>}`) — NOT a className ternary (unsupported; `AttrValue` has no conditional variant).
  - **Authoring constraint (spec review F3):** `PageLayout.tsx` MUST be a single-`return` function with NO local bindings above the return (no `const navItems = […]`). A local binding makes `lower_component_inline` return `InlineUntranslatable("local binding")` (lower.rs ~269), which **soft-falls-back to an SSR component** — i.e. the route silently loses its `<html>/<head>/<body>` shell rather than hard-erroring. The dogfood `PageLayout` is already single-return; the plan's compiler change keeps this fallback path intact (it does not turn the fallback into an error).
- **Refactor** `pages/ListPage.tsx`, `pages/DetailPage.tsx`, `pages/TypeChart.tsx` to return `<PageLayout native …>{inner}</PageLayout>`, deleting the duplicated `<BrustPage>` + sidebar + topbar + `<Island TeamBuilder>` (~50 lines × 3).
  - ListPage: `title="PokéDex · brust example"` `active="list"` `crumb="All Pokémon"`.
  - DetailPage: `title={pageTitle}` (loader path) `active="list"` `crumb={displayName}` (loader path); inner keeps the `{notFound ? … : …}` branch.
  - TypeChart: `title="PokéDex · type chart"` `active="typechart"` `crumb="Type chart"`.
- **Update** `FRAMEWORK-GAPS.md` — mark the native-layout/chrome-duplication gap ✅ FIXED (component-composition form), keeping the router-`<Outlet>` note as still-open.

## Behavior / invariants

- A `native` route-root component that inline-expands to a `<BrustPage>` root emits byte-equivalent jinja to writing `<BrustPage>` directly at the route root (same `<html lang>`, `<head>` with title/description, body). Head paths still `| e`-escaped.
- `<BrustPage>` at any non-root position (literal or via nested inline) → `BrustPageMustBeRoot` (unchanged).
- A `native` root component that does NOT root in `<BrustPage>` → normal element root (unchanged T6 behavior).
- Failed inline of the root component → SSR-component fallback + warning (unchanged soft-fallback).
- `{children}`, `active`-driven conditional nav, dynamic `crumb`/`title`, and the `ssr` `<Island TeamBuilder>` all work inside the inlined shell.

## Tests

**Compiler crate unit tests** (`crates/jsx-rust-compiler/`, `cargo test`) — the load-bearing layer, tested first (TDD):

1. **Document-root inline happy path** — route root `<Layout native title="T">…<BrustPage> body…</BrustPage></Layout>` (Layout source in `sources`) lowers to a `Component` whose `root` is `JsxNode::Document` with `title = HeadValue::Literal("T")`, `lang` defaulting to `en`.
2. **Head prop via member-path subst** — page passes `title={pageTitle}` (a bare destructured ident); Document `title = HeadValue::Path(Expr::Field("pageTitle"))` (assert `Field`, not `MemberAccess` — `MemberAccess` is only for a dotted path like `data.pageTitle`); emitted jinja contains `{{ pageTitle | e }}`.
3. **Children splice into shell** — `{children}` inside the layout's `<BrustPage>` body is replaced by the call-site children in the emitted Document body.
4. **Nested `<BrustPage>` still rejected** — `<div><BrustPage/></div>` (literal nested) → `BrustPageMustBeRoot`.
5. **Non-root layout use still rejected** — a `native` component rooting in `<BrustPage>` used **below** the route root (route root = `<div><Layout native/></div>`) does NOT become a Document. Because `doc_root_allowed` is false on the nested `try_native_inline`→`lower_component_inline` path, the layout's root `<BrustPage>` reaches `lower_element` and rejects with `BrustPageMustBeRoot` (or soft-falls-back) — it must NOT emit a nested second `<html>` shell. Assert the error/fallback, and assert no `JsxNode::Document` appears below the route root.
6. **Layout rooting in a normal element** — unchanged: produces an element root, not a Document (regression guard for existing T6).
7. **`active === 'list'` conditional element** inside the inlined layout lowers to `JsxNode::Cond` with a string-literal compare operand (guards the example's nav mechanism at the IR level).

**Regression** — existing `jsx-rust-compiler` crate tests stay green; existing native fixtures via `tests/cli-build.test.ts` (8) + `tests/integration.test.ts` (73) stay green (the `tests/fixtures/app` native routes exercise the unchanged non-layout path).

**Dogfood (manual, empirical)** — `brust build example/pokedex` then boot on a fresh port and `curl`:
- `/` → sidebar+topbar present, `is-active` on "All Pokémon", `<title>PokéDex · brust example`, TeamBuilder island SSR markup, grid content.
- `/pokemon/pikachu` → `is-active` on "All Pokémon", `<title>` dynamic (pageTitle), detail content + 2 islands.
- `/pokemon/<bad>` → notFound branch still renders (HTTP 200 body per existing S9 gap — unchanged).
- `/type-chart` → `is-active` on "Type chart", `<title>PokéDex · type chart`, grid.

## Acceptance criteria

- [ ] All 7 new compiler unit tests pass; full `jsx-rust-compiler` crate test suite green.
- [ ] `cargo fmt --all -- --check` clean; `cargo clippy --all-targets --locked -D warnings` clean.
- [ ] napi `.node` rebuilt (`cd runtime && bun run build`) — required before any `brust build` picks up the compiler change (memory `stale-napi-node-after-compiler-change`).
- [ ] `tests/cli-build.test.ts` (8) + `tests/integration.test.ts` (73) green; `bun run ci` (biome) clean.
- [ ] `example/pokedex` builds; all 4 curl checks above pass with eyes on output.
- [ ] `FRAMEWORK-GAPS.md` updated.
- [ ] No `crates/brust/src/` or TS-runtime changes (diff stays in compiler + example + spec/plan/tests).

## Known limitations (shipped intentionally)

- Only the route-root component may own the shell. A layout used below the root cannot emit `<BrustPage>`.
- Active-nav is a string-literal `active` prop compared inside the layout; adding a nav item is a code edit in `PageLayout.tsx` (acceptable for an example).
- Router-level `<Outlet>` remains unbuilt — pages still each invoke `<PageLayout>` explicitly. This is composition, not injection.
- `isr` on the route-root layout component is ignored (warn), not supported.
- `PageLayout.tsx` must be a single-return function with no local bindings above the return; violating that soft-falls-back to an SSR component (no shell), not a hard error (spec review F3).

## Open questions resolved at plan-time

- **Where the root-context boolean is threaded** — prefer a dedicated root-inline helper in `lower_with_sources` over a flag through `lower_element`/`lower_component_inline`, to bound the blast radius. Plan picks the exact seam after reading the inline helpers.
- **Whether to add a `tests/fixtures/app` native-layout route** for cli-build/integration regression coverage, or rely on crate tests + pokedex dogfood. Default: crate tests + dogfood; add a fixture route only if the reviewer flags a coverage gap.
