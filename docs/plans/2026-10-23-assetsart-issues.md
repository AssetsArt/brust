# Issues filed by Cloud by Assets Art (B-1 to B-4): plan

owner: Detoro (22499151) · authority: in-loop · coordinator: Aitthi (eee4366f)

Source: `/Users/detoro/code/assets-art-cloud/docs/brust-issues.md`, section Open (commit 3a88b7d on their `lane/assetsart-landing`). Filed against `@brust/core` 2.0.0-alpha.20, bun 1.4.4. Their lead is agent `ed1e9f68-dd52-43f8-83f0-3451d2b0f053` in workspace assets-art-cloud. Read that file for each issue's exact repro; this plan does not copy them.

## Global constraints (every task)

- Base: `origin/main` (b9a9fce0 or later). One worktree per agent under `.claude/worktrees/<name>`; reuse your existing worktree dir and `target/` (bb `host:disk`, `host:build-slots`).
- Push-only, no PR (bb `rule:no-implementer-prs`). The lead integrates.
- **Never edit the assets-art-cloud repo** and never message its agents. Questions on a repro go to the lead as a task note; the lead talks to them.
- Reproduce first: a failing test that matches the filed repro, on alpha.20 behaviour, before the fix. The READY note names the test and shows it red before and green after.
- Valid React is never a build error: when a fix cannot be complete, fail closed with a named fallback (React island), never wrong output.
- Ledger rows: the numbers below are the lead's. Each lane sets its row's state cell to done with the commit in `docs/plans/m1a-followups.md` (append the row if it is not there yet; the lead's text is in this plan).
- READY note shape: `changed:`, `why:`, `tests:` (red before, green after), `gates:` (commands + results), `unsure:`.

## Ledger rows

| row | issue | summary |
|---|---|---|
| F392 | B-1 | Full-document responses have no `<!doctype html>`, so pages render in quirks mode (static build confirmed; server path to be checked). |
| F393 | B-2 | Relative `url()` assets under Bun's inline threshold become `data:` URIs; the docs promise `client/<name>-<hash>.<ext>`. |
| F394 | B-3 (1) | Any component prop named `req`/`request`/`cookies`/`headers` is refused as request state (`captures.rs` `REQUEST_PROPS`), not only values that come from request state. |
| F395 | B-3 (1)+(2) | Diagnostics name the entry file with another file's line:col, and `nested-instance` names an innocent sibling instead of the component that causes it. |
| F399 | B-5 | A `<title>` rendered inside a page stays in `<body>` (React 19 hoists it into `<head>`), so a route cannot set its own title. Filed later, main 0fa166f of their repo. |
| F400 | B-5 (side) | Making the shared document its own layout component fails the build with `nested-instance` (a job/useId component such as `<SiteFooter>` inside an inlined component): a fallback under a document root cannot become an island, so it surfaces as a build error. F53 class. |
| F396 | B-4 | Native list: a child component inside a `.map` row gets its props function called with `undefined` on mount (client `TypeError`); server HTML is right. HIGH (wrong output on every load). |

## Decisions (settled; do not reopen)

- **F392 (B-1).** Fix at the ONE choke point where a full document is assembled, so the server, every adapter and `--target static` all get it; `static.ts` must not need its own patch. A response is a full document when its first element (after whitespace and comments) is `<html`; then, if it has no leading doctype, `<!doctype html>` is written first. Fragments (SPA navigation payloads, partial renders, `notFound` bodies that are not documents) are unchanged. Check `crates/brust-core/src/render.rs` (`doctype_end` exists) and the React render path; if they are two paths, both get it, with one shared helper per language. Tests: a served response, a static file, and Chromium `document.compatMode === "CSS1Compat"` for a root layout returning `<html>`.
- **F393 (B-2).** The documented behaviour is the contract: every relative `url()` a stylesheet references is emitted as `client/<name>-<hex10>.<ext>` and the URL rewritten, at ANY size. Brust never turns a file into a `data:` URI; a `data:` URI the author wrote stays as written. Find Bun.build's knob in `packages/brust/src/build/css.ts` (~149; e.g. a `loader` mapping for font/image extensions to `file`); if Bun has none, post-process the output. Test with a small woff2 fixture behind a package import (the `@fontsource` shape: CSS in `node_modules` with `url(./files/x.woff2)`) and a small image; assert zero `data:` in the CSS and the hashed files exist and are served.
- **F394 (B-3 part 1).** Request state is a VALUE ORIGIN, not a prop NAME. The `request-state-in-render` check applies only where the value can come from request state: the props the router passes to a route's page/layout component (what `REQUEST_PROPS` was meant to catch). An ordinary component's prop named `req` is plain data and compiles. If the compiler cannot tell a route component from a child at that pass, keep the check only for the component that is the route entry and say so in `why:`. Tests: `<Count req="18,420"/>` compiles native; a route page reading `req` in render still errors.
- **F395 (B-3 part 2).** Every diagnostic names the file whose source its `line:col` points into, and the component that owns that location. `nested-instance` names the component that HAS the job or `useId` (the cause), and, when the cause is a sibling or a prop-passed JSX element, says which (`<ActivityPanel>`'s `icon={<Rocket/>}` ...). Tests: the two filed repros produce the right file and component; a unit test that a diagnostic raised inside an inlined component from another module carries that module's path.
- **F396 (B-4).** The row item must reach the row child's props function on the client, as it does on the server. Find why the mount calls it with `undefined` (row scope not passed when the child instance is created inside a list row). If a complete fix is not possible in the lane, refuse the shape by name (React island) instead; never ship the TypeError. Tests: the filed repro as a served Chromium test with zero console errors, first paint == React, and clicking the button toggles `hidden` == React; plus a keyed reorder case and a row child whose prop is a nested object.

- **F399 (B-5).** React 19 parity, no new route field: a `<title>` and a `<meta>` (and a `<link>` that React 19 hoists: not `itemProp`, not inside `<svg>`; stylesheets keep today's handling) rendered outside `<head>` are moved into `<head>` in the server and static HTML, in render order, and the body copy is removed. Brust does not dedupe beyond what React does: an app that wants per-route titles drops the `<title>` from the layout's `<head>` (document this on the docs head/title page). On client navigation the hoisted `<title>` updates `document.title` and head `<meta>` swap like React's commit. Fix at the render choke point (the one F392 used, `render_document`), not in `static.ts`. If a page title is reactive (`<title>{x}</title>` with client state), keep it working through the existing title binding (F54) or refuse by name. Tests: served + static (`<head>` has the page title, body has none, `document.title` == React), SPA navigation between two routes with different titles, a layout title + page title pair == React's order.
- **F400 (B-5 side).** Not in a lane yet: recorded; the reply says it is tracked.

## Task table

| slug | rows | tier | role | deps | acceptance |
|---|---|---|---|---|---|
| aac-map-row-props | F396 | complex | implementer (suggested: Guetta) | - | red-then-green served test from the B-4 repro; `cargo test -p brust-compiler --no-fail-fast`; battery `--check`; shadcn `--check`; served `tests/server` files that touch lists, one file at a time; fmt + CI clippy. review: complex |
| aac-diagnostics | F394, F395 | standard | implementer (suggested: Guetta after F396, or the first idle senior) | - | both B-3 repros as tests (red before); `cargo test -p brust-compiler --no-fail-fast`; battery `--check` (the req change must not move tiers except rows that named `req`); fmt + clippy |
| aac-title-hoist | F399 | complex | implementer (first idle senior) | - | the F399 tests; `cargo test -p brust-core -p brust-server --no-fail-fast`; `cargo test -p brust-compiler --no-fail-fast` if the compiler changes; root `bun run server-test`; `cd packages/brust && bun run typecheck && bun test`; battery + shadcn `--check`; served `tests/server` files touching head/nav one at a time. review: complex |
| aac-build-assets | F392, F393 | standard | implementer (suggested: knock2) | - | served + static + Chromium compatMode test for F392; CSS asset test for F393; CI's packages/brust gates: `cd packages/brust && bun run typecheck && bun test` (full), `test -z "$(git status --porcelain)"` after the build; for a brust-core change also `cargo test -p brust-core -p brust-server --no-fail-fast`, `cargo check -p brust-core --target wasm32-unknown-unknown` (with and without `--no-default-features`), the wasm clippy line from ci.yml, and `cd packages/brust && bun test test/cf-*.test.ts`; the B-1 and B-2 repros from the filed file pass in a scratch app built with the lane's packages |

## Release and reply (lead)

After all three tasks merge: release notes list F392-F396 under fixes, cut the next alpha (incremental-publish rule), deploy brust.dev only after all six `@brust/*` show the version on npm, then tell `ed1e9f68` one line per issue: issue id + the version that fixes it. A lane that stops on a refusal instead of a fix reports that, and the reply says "refused by name (island) in <version>; full fix tracked as F<n>".

## Amendments

- 2026-10-23: the aac-build-assets acceptance named `bun run ci` in packages/brust, which does not exist on main (that was the v0.1 biome gate). Replaced by the CI gates above. Found by knock2.
- 2026-10-23: F393 keeps a `url()` suffix verbatim: `?query` and `#fragment` stay on the rewritten URL (`sprite.svg#icon` is semantic for SVG). Found by knock2 (unsure 1).

- 2026-10-23: any lane that changes a full response's bytes also runs root `bun run server-test` and `BRUST_CF_E2E=1 bun test tests/cf/pokedex-d1.test.ts` (where workerd is available): PR #355 went red on two old `<html`-start pins the listed gates did not cover. My omission.

## Risk ledger

- F392: a layout that returns `<html>` inside a fragment, or a leading comment, must still count as a document; a non-document 404 body must not gain a doctype.
- F393: Bun may re-inline in minify mode only; test with `minify` both ways.
- F394: renaming the check's scope may let a real request value through a child prop; the route-entry test must stay red.
- F396: the same props-function path may serve non-list instances; the fix must not change their call order (run the full served suite).
