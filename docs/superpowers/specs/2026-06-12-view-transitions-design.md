# Page transitions (View Transitions) + brust.run options docs — design

**Date:** 2026-06-12 · **Status:** approved (user-approved in conversation)

Two related deliverables in one spec: (A) a documentation gap — `brust.run()`
options are never enumerated in the docs; (B) a page-transition effect for the
docs site, enabled by a tiny opt-in framework hook. They ship together because
the transition's enablement is a documented capability.

## Goal

- **A.** Document every `brust.run()` option (10 fields) in the docs site so a
  reader knows what the entry call accepts, with the config precedence
  (`env > brust.toml > run() > default`) already covered in
  project-structure.md.
- **B.** SPA navigations animate with a smooth fade when the app opts in.
  Mechanism: the browser View Transitions API wrapping the existing
  `<main>` swap. Default framework behavior is UNCHANGED (instant swap) — the
  hook activates only when `<html>` carries an opt-in marker. The docs site
  opts in and ships the fade CSS; every other app is byte-for-byte unaffected
  until it opts in too.

## Non-goals

- NO `brust.run({ transition })` config knob. The transition is not a
  framework-configured feature — it is a CSS-driven capability the app enables
  via a marker attribute. (User decision: "framework just opens the channel.")
- NO per-element shared-element transitions (`view-transition-name` on
  individual elements). Only the default `root` cross-document-style fade.
- NO transition on the `attemptClientFallback` async client-takeover step —
  only the synchronous shell swap is wrapped there (see invariants). Docs is a
  prerendered SSG site and never hits the fallback path anyway.
- NO change to route matching, scroll restoration, page cache, prefetch, or the
  abort/supersession logic.

## High-level architecture

### B — framework hook (`runtime/islands/`)

A new pure helper module `runtime/islands/view-transition.ts`:

```ts
/** True iff this navigation should animate via the View Transitions API:
 *  the browser supports it AND the app opted in with the <html> marker. */
export function viewTransitionsEnabled(doc: Document): boolean {
  return (
    typeof (doc as { startViewTransition?: unknown }).startViewTransition === 'function' &&
    doc.documentElement.hasAttribute('data-brust-view-transitions')
  )
}

/** Run `commit` (the synchronous DOM-mutating navigation commit) inside a view
 *  transition when enabled, else run it directly. Returns a promise that
 *  resolves once the DOM is committed (NOT when the animation finishes), so the
 *  caller's post-commit ordering (hydration already happened inside `commit`;
 *  nav-store commit runs after) is preserved. A transition setup failure falls
 *  back to a direct commit — a navigation must never be lost to an animation. */
export async function withViewTransition(doc: Document, commit: () => void): Promise<void> {
  if (!viewTransitionsEnabled(doc)) {
    commit()
    return
  }
  try {
    await (doc as Document & {
      startViewTransition: (cb: () => void) => { updateCallbackDone: Promise<void> }
    }).startViewTransition(commit).updateCallbackDone
  } catch {
    // startViewTransition threw synchronously, or the callback rejected after
    // already mutating the DOM. Either way the commit ran (or never will) —
    // ensure a direct commit only when it did NOT run. We cannot tell, so we
    // do NOT re-run (double-commit risk). The catch exists so a VT-internal
    // rejection never propagates into navigate()'s full-reload fallback.
  }
}
```

Caveat to resolve at plan-time: the catch must not double-commit. Since
`startViewTransition(commit)` invokes `commit` exactly once (the browser
guarantees the update callback runs once, even if the transition is later
skipped), a rejection of `updateCallbackDone` means the callback itself threw —
the commit is the thing that threw, re-running it would just throw again. So
the catch swallows and the outer navigate() try/catch is the real safety net.
The plan must include a unit test pinning "commit called exactly once".

`bootstrap.ts` — both swap sites refactored to put their **synchronous**
DOM-commit steps into a `commit` closure passed through `withViewTransition`:

1. **`navigate()` normal path** (~:424-440). The closure contains, in order:
   `scrollPositions.set` (read of leaving scroll happens BEFORE the closure —
   it reads the OLD page's scrollY), then inside: `unmountIslandsIn`,
   `swapMainContent`, `applyStoreSnapshot` (fresh only), `document.title`,
   history push/replace, `scrollTo`, `hydrateMarkersIn`. After the await:
   `currentPageKey = key`, `__navCommit`. (The scroll READ stays before the
   closure; the scroll WRITE goes inside so the new scroll is part of the
   captured "new" snapshot.)
2. **`attemptClientFallback()`** (~:322-333). Wrap ONLY the synchronous shell
   swap block (`scrollPositions.set` read before; inside: `unmountIslandsIn`,
   `swapMainContent`, `title`, history, `scrollTo`, `currentPageKey`). The
   async `takeover()` + final `hydrateMarkersIn` + `__navCommit` stay OUTSIDE
   the transition (an async client fetch must not stretch the animation).

History mutation inside the callback is intentional and matches Astro/SvelteKit
practice: the URL bar updates as the new frame is captured.

### B — docs site (`example/docs`)

- **Marker:** add `data-brust-view-transitions=""` (presence-only; value
  ignored) to `<html>` via `BrustPage` in BOTH shells that render the document:
  `components/DocsLayout.tsx` (md pages) and `pages/Home.tsx` (home). `BrustPage`
  already forwards `data-*` props onto `<html>` (Document.html_attrs).
- **CSS** in `example/docs/app.css`:
  ```css
  @media (prefers-reduced-motion: no-preference) {
    ::view-transition-old(root) { animation: brust-fade-out 160ms ease both; }
    ::view-transition-new(root) { animation: brust-fade-in 200ms ease both; }
    @keyframes brust-fade-out { to { opacity: 0; } }
    @keyframes brust-fade-in { from { opacity: 0; transform: translateY(6px); } }
  }
  ```
  Reduced-motion users get the browser's snapshot swap with NO custom keyframes
  (the `@media (prefers-reduced-motion: no-preference)` guard means our
  animations simply don't exist for them; the default cross-fade is also absent
  because we don't override it — they get an instant swap). NOTE the View
  Transitions API does NOT auto-respect reduced-motion; the media guard is the
  mechanism.

### A — docs

New `## brust.run() options` section in `project-structure.md` (already the
config page), a table of all 10 fields from the `run()` signature
(`runtime/index.ts:359-383`): `routes`, `entry`, `scanRoot`, `address`, `port`,
`actions`, `actionPrefix`, `serve` (→ `Partial<ServeOptions>`: tuning/TLS/
generator — cross-link rendering.md + deployment.md), `sabBytes`, `dev`. Each
row: type, default, one-line purpose. Plus a line restating the precedence and
that env/toml override code.

## File structure

| File | Change |
|---|---|
| `runtime/islands/view-transition.ts` (new) | `viewTransitionsEnabled` + `withViewTransition` pure helpers |
| `runtime/islands/view-transition.test.ts` (new) | gate matrix + commit-once + fallback-on-throw |
| `runtime/islands/bootstrap.ts` | refactor both swap sites to commit-closure + `withViewTransition` |
| `example/docs/components/DocsLayout.tsx` | `data-brust-view-transitions=""` on BrustPage |
| `example/docs/pages/Home.tsx` | same marker on its shell |
| `example/docs/app.css` | fade keyframes under reduced-motion guard |
| `example/docs/content/navigation.md` | document how docs enables transitions + how an app opts in |
| `example/docs/content/project-structure.md` | `brust.run()` options table |

## Behavior / invariants

1. **Default unchanged:** with no `data-brust-view-transitions` marker,
   `withViewTransition` calls `commit()` directly — identical to today. No app
   sees a transition (not even a default browser cross-fade) until it opts in.
2. **Unsupported browser:** marker present but no `startViewTransition` → direct
   commit. No error, no polyfill.
3. **`commit` runs exactly once** on every path (enabled+supported,
   unsupported, unmarked, throw). This is the load-bearing correctness
   property — a double-commit would swap twice / corrupt islands.
4. **Ordering preserved:** await `updateCallbackDone` (DOM committed) before the
   post-commit steps (`currentPageKey`, `__navCommit`) so nav-store and scroll
   bookkeeping are unchanged relative to today.
5. **Abort/supersession untouched:** the existing `inFlight` AbortController and
   all `signal.aborted` checks are unchanged; the transition wraps only the
   already-synchronous commit, which today runs to completion without an abort
   check in its middle, so no new interleaving is introduced.
6. **Reduced motion:** no custom animation; the media-query guard is the only
   gate (the API does not auto-skip).

## Tests

- `runtime/islands/view-transition.test.ts` (bun, jsdom-ish via a stub Document):
  - `viewTransitionsEnabled`: 4-cell matrix (supported×marked) → only
    supported+marked is true.
  - `withViewTransition` unsupported → `commit` called once, synchronously
    before the returned promise resolves.
  - enabled (stub `startViewTransition` returning `{updateCallbackDone}`) →
    `commit` called once, inside the stubbed transition.
  - `startViewTransition` throws → `commit` was still called once (the stub
    calls it before throwing), promise resolves (no propagation).
- Existing `runtime/islands/bootstrap.test.ts` (classifyClick / swap unit tests)
  stay green — the refactor must not change their observable behavior.
- Browser smoke (Phase 6, not a committed test unless the suite has a harness):
  load docs dist, navigate between two doc pages, assert `startViewTransition`
  was invoked (spy) and that with `prefers-reduced-motion: reduce` emulated the
  custom keyframes are absent.

## Acceptance criteria

1. App WITHOUT the marker: SPA navigation is byte-identical to today (verified
   by the existing bootstrap tests staying green + a no-marker unit test).
2. Docs dist: navigating between doc pages triggers `document.startViewTransition`
   (browser smoke) and a visible fade; reduced-motion emulation shows an instant
   swap.
3. `commit` exactly once on all four paths (unit).
4. `brust.run()` options table present in project-structure.md, all 10 fields.
5. Baselines green: `bun run ci`, `bun test runtime/`, `bun run docs:build`.

## Known limitations

- Single default `root` fade only; no shared-element morphing.
- Client-fallback (static-host `fallback:'client'`) pages: only the shell swap
  animates, not the client-rendered content fill. Not exercised by docs.
- Firefox (no View Transitions as of this writing) → instant swap, no error.

## Open questions resolved

- Framework knob vs marker → marker (`data-brust-view-transitions`), CSS-driven.
- Default-on vs opt-in → opt-in via marker; zero default behavior change.
- Which swap sites → both, but fallback wraps only the sync shell swap.
- Reduced motion → `@media (prefers-reduced-motion: no-preference)` guard owns it.
- Where brust.run docs live → project-structure.md (existing config page).
