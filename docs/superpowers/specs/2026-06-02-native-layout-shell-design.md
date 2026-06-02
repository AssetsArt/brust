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

In `lower_with_sources`, when the route-root JSX is a capitalized custom component (not `Island`, not literal `BrustPage`) carrying a bare `native` attribute, take a dedicated **root-inline** path rather than the generic `lower_element`:

- Build the `subst` map from the call-site attributes exactly as `lower_ssr_component`'s native branch does (title/lang/className/active/crumb/teamProps → `Expr`; reject spreads/JSX-in-attr the same way).
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

Any other resolved shape (arith, call, etc.) keeps the existing `BrustPageAttrMustBeStringLiteral` rejection. This single added match arm (`StaticText` → `Literal`) is the only behavioral change in `lower_brust_page`; the literal/path branches are unchanged. (Escaping is unchanged — head paths still emit `{{ path | e }}` per `brust-jinja-autoescape-none`.)

### Change 3 — none for children

`splice_children_slots` already recurses into `JsxNode::Document { body, .. }` (lower.rs ~1255), so `{children}` inside the `<BrustPage>` body splices correctly with no change.

### Example refactor (`example/pokedex/`)

- **New** `components/PageLayout.tsx` — the inlined shell+chrome component (props `title`, `active: 'list' | 'typechart'`, `crumb`, `teamProps`, `children`). Active-nav uses S11 conditional **elements** (`{active === 'list' ? <a is-active/> : <a/>}`) — NOT a className ternary (unsupported; `AttrValue` has no conditional variant).
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
2. **Head prop via member-path subst** — page passes `title={pageTitle}`; Document `title = HeadValue::Path(MemberAccess|Field)` rooted at the route prop; emitted jinja contains `{{ pageTitle | e }}`.
3. **Children splice into shell** — `{children}` inside the layout's `<BrustPage>` body is replaced by the call-site children in the emitted Document body.
4. **Nested `<BrustPage>` still rejected** — `<div><BrustPage/></div>` (literal nested) → `BrustPageMustBeRoot`.
5. **Non-root layout use still rejected** — a `native` component rooting in `<BrustPage>` used **below** the route root (e.g. inside a `<div>`) does not become a Document; the nested `<BrustPage>` rejects (or soft-falls-back) — it must NOT silently emit a second shell.
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

## Open questions resolved at plan-time

- **Where the root-context boolean is threaded** — prefer a dedicated root-inline helper in `lower_with_sources` over a flag through `lower_element`/`lower_component_inline`, to bound the blast radius. Plan picks the exact seam after reading the inline helpers.
- **Whether to add a `tests/fixtures/app` native-layout route** for cli-build/integration regression coverage, or rely on crate tests + pokedex dogfood. Default: crate tests + dogfood; add a fixture route only if the reviewer flags a coverage gap.
