# reserved-x-attrs (F94): user-written `x-*` attributes never reach runtime-dom

**RULED by lead Detoro 2026-10-13.** Source: Mellow's N2 on inner-html (F94 in docs/plans/m1a-followups.md). It is the same class as inner-html's F1: the runtime must bind only directives the compiler emitted.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @40438db · flow: lane → PR → v2 → CI

## Problem

`crates/brust-jinja/src/lib.rs:585` `is_refused_attr` refuses `on*`, `srcdoc`, `x-html` and `x-raw` from user JSX. Every other `x-` name (`x-data`, `x-props`, `x-on-*`, `x-bind-*`, `x-text`, `x-if`, `x-for`, `x-show`, `x-model`, `x-ref`, …) written in a component's JSX is printed as-is on static and native templates. runtime-dom then binds it. An attacker-influenced **value** (from props, a loader or a URL) on an author-written `x-on-click` or `x-data` can call a host member by its predictable compiled name (`_h1` …) or mount any registered behavior with chosen props.

## Rule

- **Every** attribute name starting with `x-` (case-insensitive) written in user JSX on a host element is reserved. The template printer never emits it, static or dynamic, on static and native tiers.
- It is **not silent**. The reader raises a Warning diagnostic `reserved-attr`: "`x-…` attributes are reserved for brust's runtime and are not rendered". The hint says to rename it (`data-x-…`) or move the component to React. The warning carries the source location like every other diagnostic.
- React tier: React renders the island's markup. runtime-dom must not bind inside a React island's host subtree. Verify that with a test (an island whose JSX writes `x-on-click` does not fire a native handler). If it does bind, fix the walk so it does not descend into island hosts. Same rule as inner-html's opacity.
- A spread (`{...props}`) on a native/static host is already a fallback. Confirm that a spread object carrying an `x-*` key cannot reach the template or runtime binding on any tier, and add a test.
- The compiler's own emitted directives are untouched. They are generated after the user-attr filter, so the filter applies only to attributes read from source.

## Acceptance

1. `is_refused_attr` (or a new `is_reserved_attr` next to it) covers the `x-` prefix. Add a jinja unit test per directive family plus a near-miss (`xlink:href`, `data-x-foo`, `x` stay allowed).
2. Reader test: `<div x-on-click="_h1" x-data="victim" x-text={t}/>` → three `reserved-attr` warnings, none printed. Golden template has no `x-` from source.
3. Runtime tests: (a) a native page whose SSR came from such JSX has no `x-on-click` to fire; (b) a React island containing `x-on-click` markup does not bind (or the walk is fixed).
4. docs/react-coverage.md gets a battery row and a short authoring note. `packages/runtime-dom/README.md` gets one line: directives come only from compiler output.
5. Gates: mirror ci.yml (cargo fmt/clippy/test, `bun run ci`, runtime-dom, server, battery, browser, cf where feasible), then PR → v2 and CI green, reading conclusions.

## Tasks

| slug | tier | role | deps | review |
|---|---|---|---|---|
| `reserved-x-attrs` | standard | Implementer | — | complex (security) |
