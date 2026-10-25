# SPA navigation: plan

owner: Detoro (22499151) · authority: in-loop · coordinator: Aitthi (eee4366f)

Design (APPROVED by the human 2026-10-25, read it first, it is the contract):
`docs/design/2026-10-25-spa-navigation-design.md`. Section numbers below (§3, §5.9, §7 item N) point
into it. A conflict between this plan and the design is a `task challenge` to the owner, never a
silent pick.

Reading order: the design (all of it, §2 "the one rule" and §5.9 twice), then this plan's global
constraints, then your task row.

## Global constraints (every task)

- Base: `origin/main` (eba8ea34 or later). One worktree per agent under `.claude/worktrees/<name>`
  (`conclave lane start`). Reuse your `target/` (bb `host:disk`, `host:build-slots`: at most 2 cold
  cargo builds on the host; ask the coordinator for a slot).
- Push-only, no PR (bb `rule:no-implementer-prs`). The lead integrates. Never `gh workflow run
  ci.yml` on a branch.
- Walk the task state yourself: claimed → in_progress → review (memory `task-state-walk`).
- **The one rule (§2) is the test oracle.** Every served test compares a navigated page with a
  fresh full load of the same URL. A navigation that cannot be made correct falls back: one level
  higher, then a whole-body swap, then a full load (`brust:nav:error`, `swapped: false`). It is
  never a wrong page.
- New served tests (`tests/server/*.chromium.test.ts` or the existing served-test homes) are
  wired into `.github/workflows/ci.yml` in the same lane (bb `rule:served-test-in-ci`; guard
  `scripts/ci-wiring.test.ts`). Unwired = REVIEW-FAIL.
- `cd packages/brust && bun run typecheck` is a gate in every lane that touches TS
  (bb `rule:gate-typecheck`).
- After a Rust change, rebuild the napi addon before any TS or served test (memory
  `stale-napi-node-after-compiler-change`). A fresh worktree's typecheck needs
  `packages/brust/native/index.{js,d.ts}` copied from the main tree.
- Load/repro loops: at most 4 in parallel, at most 2 min, a kill trap on your own PIDs, announced
  on the task first (memory `load-test-limits`). Never a pattern `pkill`.
- Runtime bytes: `docs/runtime-budget.json` holds. A raise is measured + 10%, with a reason line.
- Ledger rows below are the lead's numbers. Each lane sets its row's state cell to `done (<sha>)`
  in `docs/plans/m1a-followups.md`. A new finding gets a provisional number in the READY note,
  and the lead renumbers it.
- READY note shape: `changed:`, `why:`, `tests:` (what is red before and green after), `gates:`
  (commands + results), `unsure:`.
- Gate cadence: a READY lane is gated once on its base. Do not re-merge main when it moves. The
  one exception is written in a row (`spa-nav-client` rebases once onto main after
  `spa-nav-server` merges).

## Ledger rows

| row | summary |
|---|---|
| F453 | Server half of SPA navigation: `nav` asset + `data-brust-nav`/`data-brust-build`/`data-brust-root` tag on every full document, production `brust-l` level markers + shell hashes from `render_chain_into` (design §5.4, §5.8, §5.9). |
| F454 | Client `nav` module: interception, prefetch, fetch + build check, asset preload, head reconciliation, level-wise swap, persist, scripts, history/scroll, the four `brust:nav:*` events, `data-brust-loading` (design §3-§5.9). |
| F455 | Runtime pieces navigation needs: React island roots unmounted on dispose, store seeding semantics (live store keeps state), F301 dev tripwire, no-core-page boot ordering (design §5.5, §5.6, §9). |
| F456 | `navigate()` API (browser + server entries), `docs/navigation.md`, a website page, the `docs/store.md` store line, brust.dev dogfood (design §5.3, §5.8). |

## Task table

| slug | rows | tier | role | deps | acceptance |
|---|---|---|---|---|---|
| spa-nav-server | F453 | standard (review: complex, shared render choke point) | implementer (suggested: knock2) | - | §7 item 15 (render.rs unit tests: markers, hash ignores the child and the injected assets and the head, a one-byte change to a level's own markup changes its hash); a served test that an all-static page carries the `nav` tag and a fragment does not; `--target static` output keeps the comments; `cargo test -p brust-core -p brust-server --no-fail-fast`; `cargo check -p brust-core --target wasm32-unknown-unknown` with and without `--no-default-features` + the wasm clippy line from ci.yml; fmt + CI clippy; root `bun run server-test`; `cd packages/brust && bun run typecheck && bun test` (full) and `bun test test/cf-*.test.ts`; the CF pokedex e2e (CI where workerd is missing); battery `--check` + shadcn `--check`; website tests |
| spa-nav-client | F454 | complex (review: complex) | implementer (suggested: Dew) | spa-nav-server merged before its served tests run (start the unit-level work at once) | §7 items 1-14 and 17 as served Chromium tests wired in ci.yml (item 14, the layout matrix, is the headline); `cd packages/runtime-dom && bun test` + the runtime budget check with a `nav` line (budget 3730 B gzip, design §5.8 amendment); `cd packages/brust && bun run typecheck && bun test`; website tests + brust.dev parity (pixels must not move on a full load) |
| spa-nav-runtime | F455 | standard (review: complex) | implementer (suggested: Guetta) | - | runtime-dom unit tests: a hydrated React island's root is unmounted when its host leaves the document (effect cleanup runs once), a live store keeps its value when a second page's snapshot tag appears, and a store first used later is seeded from its tag; F301: no dev tripwire alarm for a `late` mount; a served test in the F302 style (insert a second page's server markup after boot) for the island unmount; runtime budget holds; `cd packages/runtime-dom && bun test`; `cd packages/brust && bun run typecheck && bun test` |
| spa-nav-api-docs | F456 | routine (review: standard) | implementer (suggested: Tiësto) | spa-nav-client merged | `navigate()` unit tests (bridge present: same flow and resolves after the end event; bridge absent: `location.assign`; server entry throws "navigate is browser-only"); a served test that `navigate(url)` fires `load` then `success` with `trigger: 'navigate'`; `docs/navigation.md` with the events table, opt-outs and the preloader example from design §4; a website page in the existing docs nav; `docs/store.md:160` rewritten per §5.5; website tests + parity |

## Per-task notes (decisions settled for the builder)

### spa-nav-server (F453)

- Markers come from ONE place: `Renderer::render_chain_into` (`crates/brust-core/src/render.rs:153`).
  An inner level (`pos > 0`) is wrapped in `<!--brust-l:<id>:<hash>-->…<!--/brust-l:<id>-->`. The
  root's `<id>:<hash>` is passed out so the asset injector can write `data-brust-root` on the `nav`
  tag. Ids are the chain ids already in `chain`. They are not user input, but escape `-->` anyway
  (refuse an id that contains `-` followed by `-`, or `>`).
- The dev-only `dev_markers` scheme (`<!--brust:<id>-->…<!--/brust-->`) is REPLACED by the new one
  in dev and production alike. Its skip set (react islands) carries over as "levels that get no
  marker": an unmarked level is not keepable (§5.9). Move `packages/brust/src/dev/devtools.ts`
  (:242, :334) to the new markers. Note that the root level used to be marked in dev and is now
  carried on the tag.
- Shell hash: hash the level's own output with the child string left out. You know where the child
  sits because you inserted it as `__outlet`. A cheap way to get it: render the level, then hash the
  bytes before and after the child's marker pair. For the root, leave `<head>…</head>` out as well.
  Any stable 64-bit hash, printed as hex.
- The `nav` tag: `<script type="module" src="/_brust/<assets.nav>" data-brust-nav
  data-brust-build="<build id>" data-brust-root="<id>:<hash>">`, emitted on every full document
  (`inject_document_assets_into`) BEFORE the `if !any_dynamic { return }` exit, so all-static pages
  get it; fragments get none. Put it first among the body-end scripts. `Assets.nav` is
  `Option<String>` with `#[serde(default)]`: an older manifest loads and emits no tag.
- Build: `packages/brust/src/build/*` builds `packages/runtime-dom/src/nav/index.ts` as its own
  content-hashed asset `client/nav-<hex>.js` and records it as `assets.nav`. Create that file as a
  stub (`export {}` plus one comment line) if it does not exist. `spa-nav-client` replaces it, and
  the lead resolves that one-file conflict at integration in favour of the client lane. Build id =
  a digest of the written manifest (stable across identical builds; test that).
- Every golden/HTML-exact test that now sees the markers or the tag is updated in this lane. The
  battery's and shadcn's React-parity normalisers must strip `brust-l` comments and the `nav` tag,
  never compare them with React. Say in the READY note which normalisers you touched.

### spa-nav-client (F454)

- Code lives in `packages/runtime-dom/src/nav/*.ts`. It imports NOTHING from the runtime core
  (§5.8). It exposes `globalThis[Symbol.for('brust.nav')] = { navigate }` for F456.
- Implement the design as written: §3 steps 1-7, §4 events (names, `detail`, cancelable flags,
  ordering, `id`), §5.1-§5.4, §5.7, §5.9. Where the design says "verify", verify and write what you
  found in the READY note.
- Module imports in §3 step 4 run sequentially in document order (risk ledger, first item), unless
  you prove that a parallel import keeps the order and say so.
- Rebase ONCE onto main after `spa-nav-server` merges, then run the served tests. That is the only
  re-merge this lane does.
- The layout matrix fixture (§7 item 14) lives under the served-test fixtures. It has a counter
  component per layout (native) and one React island layout child, so the "kept vs reset" checks
  have something to count.

### spa-nav-runtime (F455)

- React islands: find where the island hydrate function creates the React root (the build-side
  emitter under `packages/brust/src/build/` and/or `packages/runtime-dom/src/island.ts`). Keep the
  root per host and `unmount()` it from the observer's dispose path (`mount.ts` `disposeTree` →
  `islandHooks.cancel`, or a new `islandHooks.dispose`). If that emitter is a file `spa-nav-server`
  also edits, announce it on the task, and the lead orders the merges.
- Stores: read `packages/runtime-dom/src/store/registry.ts` (`:53` reads the tag, `resolveRecord`)
  and pin with tests that a live record never re-reads a tag, and that a first resolve reads the
  tag present at that moment. If the code does not already behave like that, make it. Do NOT wire
  `applyStoreSnapshot`.
- F301: the dev first-paint tripwire skips bindings seeded as late mounts (`BehaviorCtx.late`).
- Boot ordering on a page without the core (§9, third item): write a runtime-dom test where the core
  is first imported while the body still holds page A, then the body is replaced by page B. B's
  hosts mount `late` and A's hosts are disposed.

### spa-nav-api-docs (F456)

- `navigate(url, { replace })` in `packages/brust/src/browser.ts`, plus a server-entry export with
  the same signature that throws `navigate is browser-only`. Types are exported from both.
- Docs follow the house style of the existing `docs/*.md` and website pages. The preloader example is
  the one in design §4, plus the pure-CSS `html[data-brust-loading]` variant.

## Outcome

(filled at integration)

## Wave 2 (2026-10-25, after alpha.26): cache, progress bar, page transitions

Design §10 (read all of it). Same global constraints as above, with one exception: this wave's base
is `origin/main` dcbb4a73 or later.

| row | summary |
|---|---|
| F458 | Client page cache (design §10.1): an LRU of 32 entries, fresh for 5 min, back/forward at any age, `no-store` and ≥ 400 never cached, `data-brust-cache`, `clearCache()` bridge + `clearNavigationCache()` export, and the actions client clearing it after a non-GET call. Fixes the human's two prefetch bugs. |
| F459 | Built-in progress bar (§10.2), on by default, shown only after 150 ms, `--brust-progress-color`, `data-brust-progress="off"`. |
| F460 | View Transitions around the swap (§10.3), on by default, root cross-fade, the six no-flicker rules, `data-brust-transition="off"`. |

| slug | rows | tier | role | deps | acceptance |
|---|---|---|---|---|---|
| spa-nav-wave2 | F458, F459, F460 | complex (review: complex) | implementer (suggested: Dew) | - | **Red-before served tests** for the two bugs: hover then wait 16 s then click = 0 new document requests; hover, leave, hover again = 1 request; back to a visited page = 0 requests. Then: a `no-store` page and a 404 are fetched again; a POST through `@brust/core/client` clears the cache (the next navigation fetches); `data-brust-cache="0"` = no cache. Progress bar: a fixture route whose loader waits 500 ms shows the bar after 150 ms and removes it after `success`; a cache hit never inserts it; opt-out works; reduced motion has no animation. Transitions: in Chromium `startViewTransition` is called exactly once per navigation, `success` fires after `updateCallbackDone`, emulated reduced motion = not called, opt-out = not called, a navigation started during a transition skips it and lands on the newer page, and §7 item 14 (the layout matrix) still passes with transitions ON. Unit tests with an ASYNC `startViewTransition` stub. `cd packages/runtime-dom && bun test && bun scripts/size.ts --check` (raise `nav` to measured + 10% with a reason line); `cd packages/brust && bun run typecheck && bun test`; `docs/navigation.md` + the website navigation page gain the cache, progress-bar and transitions sections; brust.dev sets `--brust-progress-color` to its accent; website tests + parity shots (a full load must not move); served tests wired in ci.yml |

| row | summary |
|---|---|
| F461 | Built-in `navigation` store (design §11): `@brust/core/navigation`, signals fed by the `brust:nav:*` events, server seed of `url`, readable through `useStore` in native components and React islands, the reserved name. |

| slug | rows | tier | role | deps | acceptance |
|---|---|---|---|---|---|
| spa-nav-store | F461 | standard (review: complex, compiler/store interface) | implementer (suggested: knock2) | - (independent of spa-nav-wave2; it uses only the alpha.26 event contract) | A native component AND a React island that both `useStore(navigation)`: first paint shows `idle` + the request path (served and static target); during a navigation to a slow route `state` is `loading` and `to` is set, and after it `idle` with `url` updated; `error` is set on a network failure; no hydration mismatch and no console error. A user `defineStore('navigation')` is a named build error. If the compiler cannot see a store declared in a package, fix that in this lane (memory `package-source-lane`) or say why in `unsure:`. `cargo test -p brust-compiler --no-fail-fast` if the compiler changes; battery + shadcn `--check`; `cd packages/brust && bun run typecheck && bun test`; runtime-dom tests + size check; `docs/store.md` + `docs/navigation.md` sections; served tests wired in ci.yml |

**Amendment 2026-10-25 (human):** brust.dev and the docs use the store, never a hand-written
`addEventListener`.
- spa-nav-store owns the website dogfood. brust.dev's top loading line becomes a native component
  that reads `const nav = useStore(navigation)` (`state`, `to`), and brust.dev sets
  `<html data-brust-progress="off">`, so the site's own bar is the one shown. Acceptance adds a
  served brust.dev check: the bar shows during a slow navigation and hides after it; no
  `addEventListener('brust:nav` anywhere under `website/` (a grep gate); website tests + parity
  shots.
- The preloader examples in `docs/navigation.md` and on the website navigation page lead with
  `useStore(navigation)`. The four events stay documented as the low-level reference.
- spa-nav-wave2 drops its "brust.dev sets `--brust-progress-color`" item and adds no
  `addEventListener` to the site. It merges first; spa-nav-store rebases once after it.
