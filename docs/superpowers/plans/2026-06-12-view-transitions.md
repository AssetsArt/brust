# Page transitions + brust.run docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SPA navigations fade via the browser View Transitions API when an app opts in with a `<html data-brust-view-transitions>` marker (docs site opts in); default behavior unchanged. Plus: document all 10 `brust.run()` options.

**Architecture:** A pure `withViewTransition(doc, commit)` helper gates on marker+API support and runs the synchronous nav commit inside `startViewTransition` (else directly), guaranteeing `commit` runs exactly once. `bootstrap.ts`'s two swap sites pass their sync DOM-commit steps as the closure. The docs site adds the marker (two shells) + fade CSS (with an explicit reduced-motion kill). Spec: `docs/superpowers/specs/2026-06-12-view-transitions-design.md`.

**Tech Stack:** Bun + TypeScript, bun:test (happy-dom — no real `startViewTransition`, so the helper takes `doc` as a param and tests stub it).

**Ground rules:** TS gate `bun run ci` (biome). NEVER bare tsc. No Rust in this feature. Run from repo root.

---

### Task 1: `view-transition.ts` helper + tests (TDD)

**Files:**
- Create: `runtime/islands/view-transition.ts`
- Test: `runtime/islands/view-transition.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// runtime/islands/view-transition.test.ts
import { describe, expect, test } from 'bun:test'
import { viewTransitionsEnabled, withViewTransition } from './view-transition.ts'

const MARKER = 'data-brust-view-transitions'

function stubDoc(opts: {
  supported: boolean
  marked: boolean
  throwSync?: boolean
  rejectAfter?: boolean
}): { doc: Document; cbCalls: () => number } {
  let calls = 0
  const doc = {
    documentElement: {
      hasAttribute: (n: string) => opts.marked && n === MARKER,
    },
  } as unknown as Document & { startViewTransition?: unknown }
  if (opts.supported) {
    ;(doc as { startViewTransition: unknown }).startViewTransition = (cb: () => void) => {
      if (opts.throwSync) throw new Error('sync throw before callback')
      cb()
      calls++ // count is incremented INSIDE the stub so "called by VT" is observable
      return {
        updateCallbackDone: opts.rejectAfter
          ? Promise.reject(new Error('callback rejected'))
          : Promise.resolve(),
      }
    }
  }
  return { doc, cbCalls: () => calls }
}

describe('viewTransitionsEnabled', () => {
  for (const supported of [true, false]) {
    for (const marked of [true, false]) {
      test(`supported=${supported} marked=${marked}`, () => {
        const { doc } = stubDoc({ supported, marked })
        expect(viewTransitionsEnabled(doc)).toBe(supported && marked)
      })
    }
  }
})

describe('withViewTransition — commit runs exactly once', () => {
  test('unsupported → direct commit, once, before resolve', async () => {
    const { doc } = stubDoc({ supported: false, marked: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })

  test('supported+marked → commit once, via the transition', async () => {
    const { doc } = stubDoc({ supported: true, marked: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })

  test('supported but NOT marked → direct commit, once', async () => {
    const { doc } = stubDoc({ supported: true, marked: false })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1)
  })

  test('startViewTransition throws SYNC (before callback) → commit still once (B2)', async () => {
    const { doc } = stubDoc({ supported: true, marked: true, throwSync: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1) // direct-commit fallback ran it; navigation not lost
  })

  test('updateCallbackDone rejects AFTER commit ran → commit once, no re-run (B2)', async () => {
    const { doc } = stubDoc({ supported: true, marked: true, rejectAfter: true })
    let n = 0
    await withViewTransition(doc, () => {
      n++
    })
    expect(n).toBe(1) // not re-run; rejection swallowed
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test runtime/islands/view-transition.test.ts`
Expected: FAIL — `Cannot find module './view-transition.ts'`

- [ ] **Step 3: Implement**

```ts
// runtime/islands/view-transition.ts
// Opt-in View Transitions for SPA navigation. The framework default is an
// INSTANT swap; an app opts in by putting `data-brust-view-transitions` on
// <html> and shipping the `::view-transition-*(root)` CSS itself. The helper is
// pure (takes `doc`) so it unit-tests without a real browser. Spec:
// docs/superpowers/specs/2026-06-12-view-transitions-design.md

/** True iff this navigation should animate: the browser supports the View
 *  Transitions API AND the app opted in with the <html> marker. */
export function viewTransitionsEnabled(doc: Document): boolean {
  return (
    typeof (doc as { startViewTransition?: unknown }).startViewTransition === 'function' &&
    doc.documentElement.hasAttribute('data-brust-view-transitions')
  )
}

/** Run the synchronous navigation `commit` inside a view transition when
 *  enabled, else directly. Resolves once the DOM is committed (NOT when the
 *  animation finishes) so caller ordering is preserved. `commit` runs EXACTLY
 *  once on every path:
 *   - disabled/unsupported → direct call
 *   - startViewTransition throws synchronously (before the callback) → direct
 *     call (the swap never happened — losing it would blank the page, B2)
 *   - updateCallbackDone rejects (the callback ran-and-threw) → NOT re-run. */
export async function withViewTransition(doc: Document, commit: () => void): Promise<void> {
  if (!viewTransitionsEnabled(doc)) {
    commit()
    return
  }
  const start = (doc as Document & {
    startViewTransition: (cb: () => void) => { updateCallbackDone: Promise<void> }
  }).startViewTransition
  let tr: { updateCallbackDone: Promise<void> }
  try {
    tr = start.call(doc, commit)
  } catch {
    // API threw before invoking the callback → commit never ran; run it.
    commit()
    return
  }
  try {
    await tr.updateCallbackDone
  } catch {
    // Callback already ran and threw; re-running would double-commit. Swallow
    // so a VT-internal rejection never reaches navigate()'s full-reload path.
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test runtime/islands/view-transition.test.ts`
Expected: PASS (4 enabled-matrix + 5 commit-once = 9 tests)

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/islands/view-transition.ts runtime/islands/view-transition.test.ts
git commit -m "feat(nav): view-transition helper — gated, commit-exactly-once"
```

---

### Task 2: wire `withViewTransition` into both swap sites

**Files:**
- Modify: `runtime/islands/bootstrap.ts` (import; `navigate()` commit block 426-440; `attemptClientFallback()` shell-swap 323-333)

- [ ] **Step 1: Import the helper** — add near the other `./` imports (~:30-40):

```ts
import { withViewTransition } from './view-transition.ts'
```

- [ ] **Step 2: Refactor `navigate()`** — replace the block at lines 426-440:

```ts
    scrollPositions.set(currentPageKey, window.scrollY)
    unmountIslandsIn(main as HTMLElement)
    swapMainContent(main as HTMLElement, html)
    // Only a FRESH payload re-applies the server store snapshot: replaying a
    // cached (stale) snapshot would roll back live client store state the user
    // changed since the page was first fetched.
    if (!cached && store) applyStoreSnapshot(store)
    if (title) document.title = title
    if (mode === 'push') history.pushState({}, '', url.href)
    else if (mode === 'replace') history.replaceState({}, '', url.href)
    if (mode === 'none') window.scrollTo(0, scrollPositions.get(key) ?? 0)
    else window.scrollTo(0, 0)
    hydrateMarkersIn(main as HTMLElement)
    currentPageKey = key
    __navCommit(url.pathname, url.search)
```

with (scroll READ stays before the closure; the commit steps move inside; the
two post-commit lines stay after the await):

```ts
    // scrollY of the LEAVING page is read before the transition (it must see
    // the old page's position under the old key).
    scrollPositions.set(currentPageKey, window.scrollY)
    await withViewTransition(document, () => {
      unmountIslandsIn(main as HTMLElement)
      swapMainContent(main as HTMLElement, html)
      // Only a FRESH payload re-applies the server store snapshot: replaying a
      // cached (stale) snapshot would roll back live client store state the
      // user changed since the page was first fetched.
      if (!cached && store) applyStoreSnapshot(store)
      if (title) document.title = title
      if (mode === 'push') history.pushState({}, '', url.href)
      else if (mode === 'replace') history.replaceState({}, '', url.href)
      if (mode === 'none') window.scrollTo(0, scrollPositions.get(key) ?? 0)
      else window.scrollTo(0, 0)
      hydrateMarkersIn(main as HTMLElement)
    })
    currentPageKey = key
    __navCommit(url.pathname, url.search)
```

(No abort check exists between the old commit's first and last line, and none is
added; the await of `updateCallbackDone` resolves after the synchronous commit,
so abort/supersession semantics are unchanged — a newer nav that aborts mid-await
finds the DOM already committed, exactly as today.)

- [ ] **Step 3: Refactor `attemptClientFallback()`** — replace the shell-swap block at lines 323-333:

```ts
  scrollPositions.set(currentPageKey, window.scrollY)
  unmountIslandsIn(main as HTMLElement)
  swapMainContent(main as HTMLElement, html)
  if (title) document.title = title
  // History BEFORE takeover: takeover derives params from location.pathname,
  // so the URL bar must already show the destination.
  if (mode === 'push') history.pushState({}, '', url.href)
  else if (mode === 'replace') history.replaceState({}, '', url.href)
  if (mode === 'none') window.scrollTo(0, scrollPositions.get(pageCacheKey(url)) ?? 0)
  else window.scrollTo(0, 0)
  currentPageKey = pageCacheKey(url)
```

with (only the SYNC shell swap is wrapped; the async `takeover()` below stays
OUTSIDE the transition — an animation must not wait on a client fetch):

```ts
  scrollPositions.set(currentPageKey, window.scrollY)
  await withViewTransition(document, () => {
    unmountIslandsIn(main as HTMLElement)
    swapMainContent(main as HTMLElement, html)
    if (title) document.title = title
    // History BEFORE takeover: takeover derives params from location.pathname,
    // so the URL bar must already show the destination.
    if (mode === 'push') history.pushState({}, '', url.href)
    else if (mode === 'replace') history.replaceState({}, '', url.href)
    if (mode === 'none') window.scrollTo(0, scrollPositions.get(pageCacheKey(url)) ?? 0)
    else window.scrollTo(0, 0)
    currentPageKey = pageCacheKey(url)
  })
```

(`attemptClientFallback` is already `async`; the existing `signal?.aborted` check
that follows at ~:345-348 is unchanged and still guards the async takeover.)

- [ ] **Step 4: Run the bootstrap + nav suites (must stay green — refactor is behavior-preserving)**

```bash
bun test runtime/islands/ runtime/navigation/ 2>&1 | tail -3
```
Expected: all pass (existing classifyClick / swap / fallback tests unaffected;
happy-dom has no `startViewTransition`, so `withViewTransition` always takes the
direct-commit branch under test → byte-identical to before).

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/islands/bootstrap.ts
git commit -m "feat(nav): run SPA swap through withViewTransition at both swap sites"
```

---

### Task 3: docs site opt-in — markers + fade CSS + navigation.md

**Files:**
- Modify: `example/docs/components/DocsLayout.tsx` (BrustPage marker)
- Modify: `example/docs/pages/Home.tsx` (BrustPage marker)
- Modify: `example/docs/app.css` (fade keyframes + reduced-motion kill)
- Modify: `example/docs/content/navigation.md` (document it)

- [ ] **Step 1: Marker on DocsLayout** — in `example/docs/components/DocsLayout.tsx`, add the data attribute to the `<BrustPage>` open tag (~:29-32), alongside `title`/`description`:

```tsx
    <BrustPage
      title={__md.title}
      description={__md.description}
      data-brust-view-transitions=""
```

(MUST be `=""` — a bare `data-brust-view-transitions` is a native-compiler error.)

- [ ] **Step 2: Marker on Home** — in `example/docs/pages/Home.tsx`, same addition to its `<BrustPage>` (~:38-40):

```tsx
    <BrustPage
      title="Brust — the unified framework for the web"
      description="Server pages, React islands, and native interactions share one live store. Brust compiles pages ahead of time and ships zero JavaScript until you add interactivity."
      data-brust-view-transitions=""
```

- [ ] **Step 3: Fade CSS** — append to `example/docs/app.css`:

```css
/* ── Page transitions (View Transitions API) ─────────────────────────────
   Enabled by data-brust-view-transitions on <html> (set in the BrustPage
   shells). The framework wraps the SPA <main> swap in startViewTransition;
   these rules style the default `root` snapshot. */
@media (prefers-reduced-motion: no-preference) {
  ::view-transition-old(root) {
    animation: brust-fade-out 160ms ease both;
  }
  ::view-transition-new(root) {
    animation: brust-fade-in 200ms ease both;
  }
  @keyframes brust-fade-out {
    to {
      opacity: 0;
    }
  }
  @keyframes brust-fade-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
}
/* The JS gate calls startViewTransition regardless of motion preference, so
   without this the browser's DEFAULT root cross-fade would play for
   reduced-motion users. Kill it → instant swap. */
@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(root),
  ::view-transition-new(root) {
    animation: none;
  }
}
```

- [ ] **Step 4: Document in navigation.md** — add a section (after the existing nav mechanics, before any "Next" pager) :

```md
## Page transitions

brust can animate the `<main>` swap with the browser's
[View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API).
It is **opt-in and CSS-driven** — the framework default is an instant swap.

To enable it, put the marker attribute on your document `<html>` (via
`BrustPage`) and ship the transition CSS yourself:

```tsx
<BrustPage title={title} data-brust-view-transitions="">
```

```css
@media (prefers-reduced-motion: no-preference) {
  ::view-transition-old(root) { animation: fade-out 160ms ease both; }
  ::view-transition-new(root) { animation: fade-in 200ms ease both; }
}
@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(root),
  ::view-transition-new(root) { animation: none; } /* instant swap */
}
```

Without the marker, navigation is an instant swap (no behavior change, no
default cross-fade). Browsers without the API fall back to an instant swap too.
This docs site uses exactly this setup — that smooth fade between pages is it.
```

- [ ] **Step 5: Build the docs + lint + commit**

```bash
bun run docs:build 2>&1 | tail -3   # expected: 20 pages + 20 spa payloads
bun run ci
git add example/docs/components/DocsLayout.tsx example/docs/pages/Home.tsx example/docs/app.css example/docs/content/navigation.md
git commit -m "feat(docs): opt into view transitions — markers + fade CSS + docs"
```

Verify the marker reached the built HTML:
```bash
grep -o 'data-brust-view-transitions=""' example/docs/dist/static/docs/routing/index.html | head -1
```
Expected: one match (the marker emitted on `<html>`).

---

### Task 4: `brust.run()` options docs

**Files:**
- Modify: `example/docs/content/project-structure.md` (new options section)

- [ ] **Step 1: Add the section** — in `example/docs/content/project-structure.md`, after the config-precedence paragraph (~:57), insert:

```md
## `brust.run()` options

`brust.run({...})` is the entry call. Every field:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `routes` | `FlatRoute[]` | — (required) | The route table from `defineRoutes()`. |
| `entry` | `string` | — (required) | `import.meta.url` of the entry file — anchors route/island scanning. |
| `scanRoot` | `string` | dir of `entry` | Directory scanned for routes and island sources. |
| `address` | `string` | `localhost` | Host/address to bind. |
| `port` | `number` | `1337` | TCP port to bind. |
| `actions` | `ActionsBuilder` | — | Server actions from `defineActions(...)`. Omit if the app has none. |
| `actionPrefix` | `string` | `/_brust/action` | URL prefix the action router mounts under. |
| `serve` | `Partial<ServeOptions>` | — | Lower-level server overrides merged into the listener: `tuning` (worker/connection limits — see [Deployment](/docs/deployment)), TLS, and the `generator` / `X-Powered-By` controls (see [Rendering](/docs/rendering)). |
| `sabBytes` | `number` | `262144` (256 KB) | SharedArrayBuffer size per render worker. |
| `dev` | `boolean` | `false` | Dev mode — hot reload, file watcher, dev WS, TUI. Also enabled by `BRUST_DEV=1`. |

`address` and `port` are overridable at runtime; the precedence is
**environment variables > `brust.toml` > `brust.run()` > framework default**, so
a `BRUST_PORT` or `brust.toml` value wins over what you pass here.
```

(Confirm the surrounding precedence sentence at ~:57 isn't duplicated — if it
already states the precedence, trim the closing paragraph here to just the
cross-reference.)

- [ ] **Step 2: Build + commit**

```bash
bun run docs:build 2>&1 | tail -2
git add example/docs/content/project-structure.md
git commit -m "docs: enumerate brust.run() options"
```

---

## BLOCKED fallbacks

- **Task 2 — a bootstrap/nav test breaks:** the refactor must be behavior-preserving under happy-dom (no `startViewTransition` → direct commit). If a test fails, it's a refactor slip (wrong variable captured, reordered line), NOT a VT issue — diff the closure against the original block line-by-line; do not change test expectations.
- **Task 3 — marker missing from built HTML:** the native compiler may reject `data-brust-view-transitions=""` if the attr name validation trips (it shouldn't — lowercase+hyphen is valid). If the build errors on the attribute, check `is_valid_data_attr_name` semantics; do NOT switch to a bare attribute (compiler error) — the value must stay `""`.
- **Task 3 — `docs:build` Home native compile fails on the new prop:** Home is a native route root; if BrustPage prop handling differs there, fall back to adding the marker only on DocsLayout (covers all `/docs/*` pages) and note Home is excluded.

## Self-review (plan-write time)

- Spec coverage: helper+gate+commit-once → T1; both swap sites → T2; marker(2 shells)+CSS(reduced-motion B1)+navigation.md → T3; brust.run table → T4. B2 (sync-throw vs reject) → T1 tests + impl. F1 (`=""`) → T3 step 1/2 + BLOCKED note. Acceptance #1 (no-marker unchanged) → T2 step 4 + T1 unmarked test.
- Placeholders: none — full code each step.
- Type consistency: `withViewTransition(document, () => {...})` / `viewTransitionsEnabled(doc)` names match T1↔T2; marker string `data-brust-view-transitions` identical in helper, both shells, CSS comment, docs.
