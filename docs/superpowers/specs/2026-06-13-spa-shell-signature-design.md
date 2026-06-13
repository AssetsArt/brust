# SPA navigation shell signature — full-load on layout-chain change — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** Confirmed framework bug (ketshopweb-engine studio): SPA `navigate()` across a layout-chain boundary swaps only the inner `<main>` and keeps the WRONG shell. Login (`/login`→`/`) shows the page without AppLayout chrome; logout (`/`→`/login`) keeps AppLayout chrome around the login card. Editor open/close (`/`↔`/editor/{id}`) has the same defect. Only a full reload renders the correct shell.

## Root cause (verified)

`navigationBranch` (`runtime/routes.ts:1757`) ships the destination's inner-`<main>` content whenever the destination document contains a `<main>`; the client (`bootstrap.ts` navigate()) swaps it into the *current* page's `<main>`, preserving the current shell. There is no comparison of the source vs destination LAYOUT CHAIN. The existing `isFullDocumentPayload` / no-`<main>` guards don't catch it because BOTH a layout route and a standalone route can render a `<main>` (the studio login's `<main>` lives inside its SSR'd island), so the guards never fire and the swap silently produces the wrong shell.

## Goal

The client must do a **full document load** (correct shell) when a navigation changes the layout shell, while keeping the fast inner-`<main>` swap for same-shell sibling navigation (the common case: two pages under the same layout).

Mechanism: a per-route **shell signature** (identity of the layout-ancestor chain). The server stamps it into the rendered document head AND includes the destination's signature in the nav payload; the client compares destination-vs-current and full-loads on mismatch.

## Non-goals

- Swapping a higher-up shell region (partial shell reconciliation) — full load on shell change is correct and simplest; same-shell stays a fast swap.
- Cross-document morphing/diffing.
- Changing what "same shell" means beyond the layout-ancestor chain (no per-component-prop sensitivity).
- SSR/headless changes; store/scroll/view-transition behavior on the swap path (unchanged — full load bypasses them, which is correct).

## Design

### Shell signature (`shellId`), computed once at route flatten time

In `makeFlat` (`runtime/routes.ts`, where `FlatRoute` is built from `chain`): add `shellId: string` to `FlatRoute`.

```
ancestors = chain.slice(0, -1)            // layout wrappers around the leaf's Outlet
shellId = ancestors.length > 0
  ? 'L:' + ancestors.map(routeIdent).join('>')   // all leaves under the same layout chain share this
  : 'S:' + routeIdent(leaf)                       // standalone route — unique per route
```

`routeIdent(r)` = `r.Component?.name || r.path || '?'` (server runs the real module — `Component.name` is stable; not minified server-side). Equivalence classes this produces, against the studio:
- `/` = `[AppLayout, PagesPage]` → `L:AppLayout`
- a future `/settings` = `[AppLayout, SettingsPage]` → `L:AppLayout` (SAME → fast swap ✓)
- `/login` = `[LoginPage]` → `S:LoginPage`
- `/editor/{id}` = `[EditorPageShell]` → `S:EditorPageShell`

So `/`↔`/login`, `/`↔`/editor`, `/login`↔`/editor` all differ → full load; sibling pages under AppLayout swap fast. Correct.

Edge: two distinct layouts sharing a component name would collide (both `L:Name`). Acceptable v1; could disambiguate with the chain's fullPath structure later. Document.

### Server — stamp the signature (mirror the generator-meta dual-path precedent EXACTLY)

The generator meta already solves "get a `<meta>` into both native and React documents": native bakes at emit (`insertGeneratorMeta`, native-routes-emit.ts), React injects at render (`injectGeneratorMeta`, render/stream.ts). The shell meta follows the same two sites.

Marker: `<meta name="brust-shell" content="<shellId>">` inserted before `</head>`.

1. **Native (emit time)** — native-routes-emit.ts: each flat route composes one native template; bake its `shellId`'s meta into the composed head right where `insertGeneratorMeta` runs (the shell sig is per-flat-route, available in the emit loop). Fragment child templates have no own head — the LAYOUT's BrustPage head is where it lands, which is exactly the shell document. A standalone route's own BrustPage head gets its `S:` sig.
2. **React (render time)** — render/stream.ts: new `injectShellMeta(body, shellId)` mirroring `injectGeneratorMeta` (find `</head>`, insert-if-absent guarded by a `name="brust-shell"` byte check, same as the generator GUARD). Thread `shellId` into `RenderBranchStreamingArgs` (routes.ts render branch passes `flat.shellId`). Both the buffering and streaming-prepend paths (the two injection sites generator/store already use).

Note: `shellId` must be available wherever these run — it's on `FlatRoute`, already threaded to both the render branch and navigationBranch.

### Server — nav payload carries the destination signature

`navigationBranch` (routes.ts ~1765): add `shell: flat.shellId` to the JSON payload `{ html, title, store, shell }`. (Uniform — no HTML parsing; navigationBranch already has `flat`.)

### Client — compare and full-load on mismatch

`runtime/islands/bootstrap.ts`:
- `PagePayload` type gains `shell?: string`. (`fetchPagePayload` / page cache already round-trip the whole object → `shell` is cached and replayed automatically.)
- Read current shell at boot into a module var: `let currentShell = document.querySelector('meta[name="brust-shell"]')?.getAttribute('content') ?? null`.
- In `navigate()`, after obtaining `payload` and BEFORE the inner-`<main>` swap, alongside the existing `isFullDocumentPayload` guard:
  ```
  if (currentShell && payload.shell && payload.shell !== currentShell) {
    location.href = url.href   // shell changed → authoritative full load
    return
  }
  ```
  **Both-present guard is load-bearing:** if either side is absent (old cached payload without `shell`, or a stale addon that didn't bake the meta), fall through to existing behavior — never over-full-load. Same-shell nav: `payload.shell === currentShell` → existing swap path runs untouched.
- Apply the identical guard in `attemptClientFallback` (the SSG static-host path) for consistency.
- `currentShell` does NOT change on a same-shell inner-main swap (the `<head>` meta is untouched by `swapMainContent`, which only replaces `<main>`'s children) — so no update needed. After a full load the fresh document re-seeds it at boot.
- popstate uses the same `navigate(..., 'none')` path → covered.

## File structure

- `runtime/routes.ts` — `FlatRoute.shellId` + `makeFlat` computation; render branch threads `flat.shellId`; `navigationBranch` payload `shell`.
- `runtime/render/stream.ts` + new `runtime/render/inject-shell-meta.ts` — React render-time inject (mirror inject-generator.ts).
- `runtime/cli/native-routes-emit.ts` — emit-time bake (mirror generator).
- `runtime/islands/bootstrap.ts` — `PagePayload.shell`, `currentShell`, the two guards.
- Tests: `runtime/islands/bootstrap.test.ts` (or nav test) — shell-mismatch full-load, same-shell swap, missing-shell fallthrough; `runtime/render/inject-shell-meta.test.ts`; native emit test asserts the meta bakes; integration test in tests/ booting a fixture with a layout route + a standalone route and asserting nav payload `shell` + cross-shell behavior.
- Docs: architecture.md SPA-nav section + native/routing docs note the shell-change = full-load semantics.

## Behavior invariants

1. Same shell (siblings under one layout) → inner-`<main>` swap, byte-identical to today (fast path untouched).
2. Different shell → full document load (correct chrome). Covers `<a>` clicks, `navigate()`, popstate, prefetch-cache hits, SSG fallback.
3. Missing signature on EITHER side → existing behavior (no new full-loads) — backward/stale-addon safe.
4. The `<main>` extraction + `isFullDocumentPayload` guards remain (defense in depth; the shell check is the primary fix).
5. No change to store snapshot / scroll / view-transition logic on the swap path.

## Tests

- Client unit (happy-dom): payload.shell ≠ currentShell → `location.href` set, no swap; payload.shell == currentShell → swap runs; payload.shell undefined OR no meta → swap runs (fallthrough); cache-hit nav with differing shell → full load.
- `injectShellMeta`: inserts before `</head>`, idempotent (byte-guard), no-op when sig empty.
- Native emit: a composed template's head contains `<meta name="brust-shell" content="L:...">` (layout) / `S:...` (standalone).
- Integration (fixture with a layout route wrapping an index + a sibling standalone route): GET `/_brust/page/<standalone>` while "on" the layout route → payload `shell` differs; assert the two shellIds; assert a same-layout sibling shares the shellId. (Server-side payload assertion; the client full-load is unit-tested.)
- Full `bun test` + cargo (no Rust change expected — verify) + biome green.

## Acceptance criteria

The studio login→`/`, logout→`/login`, and editor open/close render the correct shell WITHOUT a manual reload; same-layout sibling nav stays a fast swap; all suites green; docs updated. Ship as the next alpha.

## Open questions resolved at plan-time

- Whether native fragment children (no own head) get the meta: no — it lands in the layout's BrustPage head, which is the shell document. Confirmed correct.
- Whether any Rust change is needed: not expected (shellId is TS-side; meta injection is TS emit + TS render). Verify during impl.
