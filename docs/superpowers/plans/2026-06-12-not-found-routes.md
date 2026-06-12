# 404 Layout / Page Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. Each task is committed independently; baselines stay green between tasks.

**Goal:** First-class catch-all (`{ path: '*' }`) 404 routes that render the nearest catch-all (with its layout chain) at HTTP 404 across native, React, SSG, and SPA paths.

**Architecture:** Post-router fallback tier — catch-alls stay in the route array (route_id stable) but skip matchit insert; on matchit NoMatch a prefix-indexed table selects the nearest catch-all (longest segment-prefix) and renders it at 404. Spec: `docs/superpowers/specs/2026-06-12-not-found-routes-design.md`.

**Tech Stack:** Rust (brust-core, matchit 0.9, serde), TypeScript runtime (Bun), React 19, jinja native compiler.

**Baselines (run between tasks, must stay green):**
```bash
cargo test --workspace --locked                    # ~488
cd runtime && bun run build:debug && cd ..          # rebuild napi after Rust edits
bun test runtime/                                   # ~719
for f in native-island native-island-ssr integration; do bun test tests/$f.test.ts; done
bun run ci                                           # biome
```

**CRITICAL invariants (every task respects):**
- Catch-all FlatRoutes KEEP their array index = route_id on BOTH sides (Rust `idx as u32`, TS `byRouteId`). Never remove from the array; only skip the matchit insert.
- After ANY Rust edit, rebuild `runtime/*.node` (`cd runtime && bun run build:debug`) or tests use a stale binary.
- TS gate is `bun run ci` (biome), NOT tsc.
- No string "nextjs" anywhere (branches/commits/PRs/comments).
- Additive: an app with NO catch-all must be byte-identical to today (empty table → existing `error_404()`).

---

## Task 1: TS flatten — detect `{ path: '*' }`, flag it, compute prefix

**Files:**
- Modify: `runtime/routes.ts` (the `Route` type ~:317-390; flatten/`walkRoutes` ~:537-562; `FlatRoute` ~:396; the install-payload builder that sends `path`/`native_template` to Rust)
- Test: `runtime/routes.test.ts`

A catch-all is a leaf with `path === '*'`. In flatten: KEEP it in the flat `out` array (stable index), set `flat.notFound = true` and `flat.notFoundPrefix = <parent basePath>` (root → `''`). Its `fullPath` is NOT a matchit pattern — set it to a sentinel (e.g. the prefix itself) and rely on the `notFound` flag so install skips the matchit insert. Validate: a catch-all may not have `children` or `index` (throw `Error('catch-all route "*" must be a leaf')`); at most one catch-all per `notFoundPrefix` (throw on duplicate).

- [ ] **Step 1 — Write failing tests** in `runtime/routes.test.ts`:
```ts
test("catch-all '*' leaf is flagged notFound with parent prefix, kept in array", () => {
  const flat = flattenRoutes(defineRoutes([
    { path: '/', Component: Home as any },
    { path: '/docs', Component: Layout as any, children: [
      { path: 'intro', Component: Intro as any },
      { path: '*', Component: DocsNF as any },
    ]},
    { path: '*', Component: GlobalNF as any },
  ]))
  const nf = flat.filter((f) => f.notFound)
  expect(nf.map((f) => f.notFoundPrefix).sort()).toEqual(['', '/docs'])
  // every flat route still has a stable, contiguous index (route_id integrity)
  expect(flat.length).toBe(flat.filter((_, i) => i === flat.indexOf(flat[i])).length)
})
test("catch-all with children throws", () => {
  expect(() => flattenRoutes(defineRoutes([
    { path: '*', Component: X as any, children: [{ path: 'y', Component: Y as any }] },
  ]))).toThrow(/leaf/)
})
test("two catch-alls under the same prefix throw", () => {
  expect(() => flattenRoutes(defineRoutes([
    { path: '*', Component: A as any }, { path: '*', Component: B as any },
  ]))).toThrow(/duplicate|one catch-all/i)
})
```
(Use the real exported flatten fn name — find it; likely `flattenRoutes` or inside `defineRoutes`. If flatten isn't exported, test via `defineRoutes` + the install-payload builder.)

- [ ] **Step 2 — Run, verify fail:** `bun test runtime/routes.test.ts -t "catch-all"` → FAIL (notFound undefined).
- [ ] **Step 3 — Implement:** add `notFound?: boolean` + `notFoundPrefix?: string` to `FlatRoute`; in `walkRoutes`, when a leaf has `path === '*'`, set the flags (prefix = the parent `basePath`, root = `''`), validate leaf-only + dedupe per prefix. In the install-payload builder, emit `notFound: true` + `notFoundPrefix` for those configs (camelCase JSON keys — Rust reads via serde rename).
- [ ] **Step 4 — Run:** `bun test runtime/routes.test.ts -t "catch-all"` → PASS.
- [ ] **Step 5 — Full TS baseline + biome:** `bun test runtime/ && bun run ci` → green.
- [ ] **Step 6 — Commit:** `feat(routes): flatten catch-all '*' routes as notFound entries`

**BLOCKED fallback:** if `basePath` at the leaf is not the clean parent prefix (e.g. includes the `'*'`), strip the trailing `/\*?$/` and any trailing slash to derive the prefix; assert prefix has no `*`.

---

## Task 2: Rust — RouteConfig fields + not_found_table + select_not_found + MatchResult::NotFound

**Files:**
- Modify: `crates/brust-core/src/routing/routes.rs` (`RouteConfig` ~:224-234; `Router` struct ~:238; `install_with_config` loop ~:256-302; `MatchResult` ~:219-221; `match_path` ~:335-376)
- Test: same file's `#[cfg(test)]` module

Add to `RouteConfig`:
```rust
#[serde(default, rename = "notFound")]
pub not_found: bool,
#[serde(default, rename = "notFoundPrefix")]
pub not_found_prefix: String,
```
Add to `Router`: `not_found_table: RwLock<Vec<(String, u32)>>`. In the install loop: if `c.not_found` → push `(c.not_found_prefix.clone(), idx as u32)` to a local vec and **`continue` past `router.insert`** (skip matchit), but STILL push cache/native_template/etc. so indices stay aligned. After the loop, sort the table by prefix length DESC and store it. Add `MatchResult::NotFound { route_id: u32, envelope: RouteEnvelope<'a> }`. Add:
```rust
/// Longest segment-prefix match. "" matches everything (last resort).
fn select_not_found(table: &[(String, u32)], path: &str) -> Option<u32> {
    table.iter()
        .filter(|(p, _)| p.is_empty() || path == p || path.starts_with(&format!("{p}/")))
        .max_by_key(|(p, _)| p.len())
        .map(|(_, id)| *id)
}
```
In `match_path`, on the matchit `Err(_) => NoMatch` branch: call `select_not_found`; if `Some(id)` → build a `RouteEnvelope` (reuse the request envelope, empty params, real path) → `MatchResult::NotFound { route_id: id, envelope }`; else keep `NoMatch`.

- [ ] **Step 1 — Failing tests:**
```rust
#[test]
fn select_not_found_longest_segment_prefix() {
    let t = vec![(String::new(), 9u32), ("/docs".into(), 3u32)];
    assert_eq!(select_not_found(&t, "/docs/missing"), Some(3));
    assert_eq!(select_not_found(&t, "/other"), Some(9));      // root last-resort
    assert_eq!(select_not_found(&t, "/docs"), Some(3));        // exact prefix
    assert_eq!(select_not_found(&t, "/docsearch"), Some(9));   // NOT /docs (boundary)
}
#[test]
fn select_not_found_empty_table_is_none() {
    assert_eq!(select_not_found(&[], "/x"), None);
}
#[test]
fn match_path_returns_not_found_when_catchall_registered() {
    // install one real route + one not_found(prefix "") → unmatched path yields NotFound{id}
}
```
- [ ] **Step 2 — Run, fail:** `cargo test -p brust-core select_not_found` → FAIL (fn missing).
- [ ] **Step 3 — Implement** the fields, table, fn, and match_path branch.
- [ ] **Step 4 — Run:** `cargo test -p brust-core` → PASS (incl. existing match/asset-precedence tests).
- [ ] **Step 5 — Commit:** `feat(core): not-found fallback tier — catch-all table + select_not_found`

**BLOCKED fallback:** if reusing `RouteEnvelope` lifetimes in the NoMatch branch fights the borrow checker (the request strings must outlive the envelope), construct the NotFound envelope from the same `full_path`/headers refs the `Matched` branch uses — mirror that branch's envelope build exactly.

---

## Task 3: Rust server — dispatch NotFound at both match sites

**Files:**
- Modify: `crates/brust-core/src/server/mod.rs` (general render match ~:628; SPA-nav `/_brust/page` ~:605-625; `error_404()` stays last-resort)
- Test: `tests/integration.test.ts` (or a new `tests/not-found.test.ts`)

At the general site: `MatchResult::NotFound { route_id, envelope }` → call the SAME render dispatch the `Matched` arm uses, passing the route_id + a flag/marker that the JS side renders at 404 (the render request gains a `notFound: true` field, or the JS infers 404 from the flat route's `notFound`). At the `/_brust/page` site: replace the bare `{"error":"not found"}` JSON (on NoMatch) with the NotFound dispatch as a navigation render, status 404 — so the SPA gets a real body.

- [ ] **Step 1 — Failing integration test:** boot a fixture app with a global catch-all; `GET /nope` → status 404 AND body contains the catch-all's marker text; `GET /_brust/page/nope` → 404 with a JSON/marker payload that carries a body (not `{"error":"not found"}`).
- [ ] **Step 2 — Run, fail.**
- [ ] **Step 3 — Implement** both dispatch sites. Keep `error_404()` when `select_not_found` → None.
- [ ] **Step 4 — Rebuild napi + run:** `cd runtime && bun run build:debug && cd .. && bun test tests/not-found.test.ts` → PASS.
- [ ] **Step 5 — Commit:** `feat(core): render catch-all at 404 on unmatched (render + SPA-nav sites)`

**BLOCKED fallback:** if threading a new render field through the napi RenderDispatch seam is invasive, infer 404 entirely on the JS side from `flat.notFound` (Task 4) and have Rust just dispatch the route_id normally — the JS render sets status 404. Prefer this if the napi signature is rigid.

---

## Task 4: TS render dispatch — render catch-all flat route at status 404 (native + React)

**Files:**
- Modify: `runtime/routes.ts` (render dispatch ~:790-1000; `renderStatus` computation ~:975-989; `byRouteId.get(route_id)` ~:797)
- Test: `runtime/routes.test.ts`

When the dispatched `flat` has `notFound === true`, force `renderStatus = 404` unconditionally (native verdict path already carries status to the response; React uses the same `renderStatus` field at ~:1164). The catch-all renders with its full `flat.chain` (layout loaders run; spec). Works for both native and React leaves.

- [ ] **Step 1 — Failing tests:** dispatch a native catch-all flat → response status 404 + template HTML; dispatch a React catch-all flat → status 404 + component HTML. (Use the existing render-dispatch test harness; mirror a Matched-route test.)
- [ ] **Step 2 — Run, fail.**
- [ ] **Step 3 — Implement** the `renderStatus = 404` force when `flat.notFound`.
- [ ] **Step 4 — Run:** `bun test runtime/routes.test.ts` → PASS.
- [ ] **Step 5 — Rebuild + native baselines:** `cd runtime && bun run build:debug && cd .. && bun test tests/native-island.test.ts tests/native-island-ssr.test.ts` → green.
- [ ] **Step 6 — Commit:** `feat(routes): render catch-all leaves at HTTP 404 (native + React)`

---

## Task 5: React `notFound()` trigger — sentinel throw + re-render nearest catch-all

**Files:**
- Modify: `runtime/routes.ts` (export `notFound()` on the React side; loader runs in `buildRenderElement` ~:1600; the 500 catch ~:1138)
- Export: ensure `brustjs/routes` re-exports it (check `runtime/routes.ts` exports + the package entry)
- Test: `runtime/routes.test.ts`

Add a tagged sentinel: `const NOT_FOUND = Symbol.for('brust.notFound')`; `export function notFound(): never { throw { [NOT_FOUND]: true } }`. In the render path, BEFORE the generic 500 handler (~:1138), discriminate the sentinel: if caught, select the nearest catch-all for the route's prefix (same selection as unmatched — reuse a shared helper or the flat table on the JS side), then re-run `buildRenderElement` against THAT catch-all's chain at `renderStatus = 404`. No conflict with ActionError (action-dispatch only).

- [ ] **Step 1 — Failing tests:** a React route whose loader calls `notFound()` → response status 404 + the **catch-all's** HTML (not the route's own Component, not a 500/errorBoundary). With no catch-all registered → status 404 + default body.
- [ ] **Step 2 — Run, fail.**
- [ ] **Step 3 — Implement** sentinel + discrimination + re-render. Export `notFound`.
- [ ] **Step 4 — Run + biome:** `bun test runtime/routes.test.ts && bun run ci` → green.
- [ ] **Step 5 — Commit:** `feat(routes): React notFound() loader trigger renders nearest catch-all`

**BLOCKED fallback:** if re-running `buildRenderElement` against a different chain mid-dispatch is structurally hard, have `notFound()` set a flag on the render context that, on catch, short-circuits to a fresh dispatch of the selected catch-all route_id (reusing Task 4's path) instead of re-entering buildRenderElement.

---

## Task 6: SPA bootstrap — 404-with-body swaps content, no full-reload

**Files:**
- Modify: `runtime/islands/page-cache.ts` (`fetchPagePayload` ~:63 throws on `!ok`); `runtime/islands/bootstrap.ts` (swap path ~:435-448, full-reload fallback ~:456-460)
- Test: `runtime/islands/bootstrap.test.ts`

A 404 carrying a rendered page payload is renderable, not a transport error: don't throw for a 404-with-payload; route it through the shared swap (content + URL + title), at `replaceState` (a 404 shouldn't add a pushable "real" entry — confirm UX; spec says swap). Set the `cached` flag correctly so `applyStoreSnapshot` runs (a fresh 404 fetch is NOT cached). Keep full-reload for true transport failures (network/5xx/empty). Must not break `attemptClientFallback`.

- [ ] **Step 1 — Failing tests:** mock a page-payload fetch returning 404 WITH a body → bootstrap swaps `[data-brust-...]` content + updates title, does NOT set `location.href`. A fetch that rejects (network) or returns 5xx → still full-reloads.
- [ ] **Step 2 — Run, fail.**
- [ ] **Step 3 — Implement.**
- [ ] **Step 4 — Run:** `bun test runtime/islands/bootstrap.test.ts` → PASS.
- [ ] **Step 5 — Commit:** `feat(nav): SPA renders 404 page in-place instead of full reload`

---

## Task 7: SSG — global catch-all → 404.html, compose with fallback script

**Files:**
- Modify: `runtime/cli/ssg.ts` (404.html write ~:544-572; `fallback404Html` ~:275-305; public/404.html check ~:564)
- Test: `runtime/cli/ssg.test.ts`

If a global catch-all (prefix `''`) exists and no app `public/404.html`: crawl it at a sentinel path and write the rendered HTML to `staticOut/404.html`. If `fallback:'client'` routes ALSO exist, inject the existing `fallback404Html` redirect `<script>` (the pattern→shell matcher, WITHOUT its `<p>Not found.</p>` shell) into the crawled page before `</body>`. Only fallbacks, no catch-all → unchanged. App `public/404.html` still wins.

- [ ] **Step 1 — Failing tests:** (a) app with global catch-all, no fallbacks → `staticOut/404.html` == crawled NotFound HTML; (b) app with catch-all + fallbacks → 404.html contains BOTH the NotFound body AND the fallback redirect script; (c) app `public/404.html` present → not overwritten; (d) no catch-all, no fallbacks → no framework 404.html.
- [ ] **Step 2 — Run, fail.**
- [ ] **Step 3 — Implement.** Factor the redirect-script-only out of `fallback404Html` so it can be injected.
- [ ] **Step 4 — Run:** `bun test runtime/cli/ssg.test.ts` → PASS.
- [ ] **Step 5 — Commit:** `feat(ssg): generate 404.html from the global catch-all page`

---

## Task 8: Docs dogfood — NotFound page, register catch-all, drop public/404.html

**Files:**
- Create: `example/docs/components/NotFound.tsx` (native, branded — port the look of the current `public/404.html`)
- Modify: `example/docs/routes.tsx` (register catch-all(s)); `example/docs/lib/nav.ts`/mdRoutes IF adding the `notFound?` option (only if small — else root global only, note follow-up)
- Delete: `example/docs/public/404.html`
- Test: build + browser-verify

Decide per the spec's remaining open question: if `mdRoutes` gains a small `notFound?` option, mount `NotFound` inside `DocsLayout` for the `/docs` prefix AND a root global; else ship a root global catch-all only and note the docs-sidebar-404 as a fast-follow.

- [ ] **Step 1 — Implement** `NotFound.tsx` (native, BrustPage shell, links Home + /docs), register catch-all in `routes.tsx`, delete `public/404.html`.
- [ ] **Step 2 — Build SSG:** `bun run docs:build` → `dist/static/404.html` is the rendered NotFound page (grep for its marker, NOT the old static title).
- [ ] **Step 3 — Boot live + curl:** `bun run docs` (or index.ts) then `curl -si localhost:1340/nope | head -1` → `404`; body contains NotFound marker. SPA: load a real page, click a dead link / pushState to `/nope` → 404 page renders in-place.
- [ ] **Step 4 — Browser-verify** (headless playwright, the standalone one that worked): screenshot `/nope` renders the branded 404; if docs-section catch-all shipped, `/docs/nope` shows the sidebar.
- [ ] **Step 5 — biome + commit:** `bun run ci` then `feat(docs): dogfood framework 404 page; remove static public/404.html`

---

## Self-review — spec coverage

| Spec section | Task |
|---|---|
| API: catch-all `'*'` declaration | 1 |
| route_id ↔ index invariant | 1, 2 |
| Post-router fallback tier (select_not_found) | 2 |
| RouteConfig serde fields | 2 |
| Rust unmatched → 404 (both sites incl /_brust/page) | 3 |
| Status threading native + React | 4 |
| React `notFound()` parity | 5 |
| SPA client 404 render (no reload) | 6 |
| SSG 404.html + fallback compose | 7 |
| Docs dogfood + remove public/404.html | 8 |
| Additive (no catch-all = byte-identical) | 2 (empty table), verified in Phase 6 |

**Type consistency:** `notFound`/`notFoundPrefix` (TS FlatRoute + JSON keys) ↔ `#[serde(rename = "notFound"/"notFoundPrefix")]` `not_found`/`not_found_prefix` (Rust). `MatchResult::NotFound { route_id, envelope }`. `select_not_found(&[(String,u32)], &str) -> Option<u32>`.
