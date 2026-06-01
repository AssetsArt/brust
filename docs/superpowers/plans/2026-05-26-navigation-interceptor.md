# Navigation Interceptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert plain `<a href>` clicks into JSON page fetches that swap the `<main>` element in place, update `document.title`, re-hydrate islands, and pushState. Any failure degrades to `location.href = url` so the user always navigates.

**Architecture:** Reuses the existing render pipeline. Rust's `handle_conn` adds a `/_brust/page/` prefix branch that strips the prefix, resolves the route, rewrites the envelope's `kind` from `"render"` to `"navigation"`, and dispatches through the same `dispatch_to_worker_and_stream_chunks` helper. JS-side `makeRenderer` branches on `kind:'navigation'` to a new `navigationBranch` that runs `renderToString` and regex-extracts `<main>` + `<title>` into a JSON envelope. Client-side: the existing bootstrap chunk gains a `hydrateMarkersIn(root)` refactor + a `swapMainContent` helper + a global `click` interceptor + `popstate` listener.

**Tech Stack:** Rust (tokio, NAPI for dispatch), TypeScript (Bun runtime + React 18 SSR `renderToString`), browser (`fetch`, `Range.createContextualFragment`, `history.pushState`).

**Spec:** `docs/superpowers/specs/2026-05-26-navigation-interceptor-design.md` (376 lines).

---

## Phase 1: Rust route branch

### Task 1: `rewrite_envelope_kind` helper + Rust unit test

Add a pure substring-replace helper in `src/routes.rs` that swaps the envelope's `kind` field. The envelope is JS-built JSON with stable field order, so a targeted `replacen` (first occurrence only) is correct and avoids a parse-rewrite-serialise round-trip.

**Files:**
- Modify: `/Users/detoro/code/brust/src/routes.rs` (add helper + tests)

- [ ] **Step 1: Write failing tests at the bottom of `src/routes.rs::tests`**

Find the existing `#[cfg(test)] mod tests` block (or append a new one at end of file). Add:

```rust
#[cfg(test)]
mod rewrite_envelope_kind_tests {
    use super::rewrite_envelope_kind;

    #[test]
    fn swap_render_to_navigation() {
        let envelope = r#"{"kind":"render","path":"/blog/x","route_id":2}"#.to_string();
        let out = rewrite_envelope_kind(envelope, "navigation");
        assert_eq!(out, r#"{"kind":"navigation","path":"/blog/x","route_id":2}"#);
    }

    #[test]
    fn replaces_only_first_occurrence() {
        // Defensive — if route data ever contains the literal "kind":"render" later in
        // the JSON (it shouldn't), we must NOT touch it. The discriminant is always first.
        let envelope = r#"{"kind":"render","data":"\"kind\":\"render\""}"#.to_string();
        let out = rewrite_envelope_kind(envelope, "navigation");
        assert_eq!(out, r#"{"kind":"navigation","data":"\"kind\":\"render\""}"#);
    }

    #[test]
    fn missing_kind_returns_input_unchanged() {
        let envelope = r#"{"foo":"bar"}"#.to_string();
        let out = rewrite_envelope_kind(envelope, "navigation");
        assert_eq!(out, r#"{"foo":"bar"}"#);
    }
}
```

- [ ] **Step 2: Run tests — they must FAIL with "cannot find function `rewrite_envelope_kind`"**

Run from `/Users/detoro/code/brust`:
```
cargo test --lib routes::rewrite_envelope_kind_tests 2>&1 | tail -15
```
Expected: compile error `cannot find function 'rewrite_envelope_kind' in this scope`.

- [ ] **Step 3: Add the helper above the `tests` module**

Insert this near the other envelope helpers in `src/routes.rs` (search for `build_action_envelope` or `build_sse_envelope` — add `rewrite_envelope_kind` in the same neighbourhood):

```rust
/// Swap `"kind":"<old>"` → `"kind":"<new>"` in a JS-built JSON envelope
/// string. The envelope's field order is stable (the JS builder always
/// emits `kind` first), so a single targeted substring replace is correct
/// and cheaper than a parse-rewrite-serialise round-trip. Returns the input
/// unchanged if the `"kind":"render"` substring isn't found (defensive).
pub fn rewrite_envelope_kind(envelope_json: String, new_kind: &str) -> String {
    envelope_json.replacen(
        r#""kind":"render""#,
        &format!(r#""kind":"{}""#, new_kind),
        1,
    )
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `cargo test --lib routes::rewrite_envelope_kind_tests 2>&1 | tail -10`
Expected: `test result: ok. 3 passed`.

- [ ] **Step 5: Run full lib tests — confirm no regression**

Run: `cargo test --lib 2>&1 | tail -3`
Expected: `test result: ok. 93 passed` (90 prior + 3 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/detoro/code/brust && git add src/routes.rs && git commit -m "$(cat <<'EOF'
feat(routes): rewrite_envelope_kind helper for navigation dispatch

Pure substring-replace helper. Swaps "kind":"render" → "kind":"<new>"
in a JS-built JSON envelope so the /_brust/page/ branch (Task 2) can
reuse the existing route_match -> envelope_json pipeline and just
re-discriminate the kind to navigation.

Defensive on the "no match" path — returns the input unchanged so a
caller that picks up an already-rewritten envelope can't double-mutate.

3 unit tests cover: render→navigation swap, first-occurrence-only
behaviour (defensive against the literal substring appearing later
in JSON body data), missing-kind passthrough.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `/_brust/page/` prefix branch in `handle_conn`

Add a branch to `src/server.rs::handle_conn` that intercepts `GET /_brust/page/{path}` requests. The branch strips the prefix, resolves the real route via the existing `routes.match_path`, rewrites the envelope kind via Task 1's helper, then dispatches through the same `dispatch_to_worker_and_stream_chunks` used for render requests (cache callback is a no-op since navigation responses are not cached).

**Files:**
- Modify: `/Users/detoro/code/brust/src/server.rs`

- [ ] **Step 1: Locate the insertion point**

Run:
```
grep -nE "^        // .*[Rr]ender|^        let.*envelope_json.*routes\.match_path" /Users/detoro/code/brust/src/server.rs | head -5
```
Find the render-branch block in `handle_conn` (search for `routes.match_path` — around line 720). The new branch goes IMMEDIATELY BEFORE this block, AFTER the framework `/_brust/cache/*` / `/_brust/action/*` / `/_brust/islands/*` / `/_brust/mcp` blocks. Read the surrounding 30 lines to anchor the insertion.

- [ ] **Step 2: Insert the navigation branch**

Insert ABOVE the existing `match routes.match_path(&method, &path, &buf)` line (the render branch's match):

```rust
        // Navigation interceptor: client-side SPA navigation fetches arrive at
        // /_brust/page/{real_path} and want a JSON {html, title} envelope back
        // (the JS-side `navigationBranch` handles the serialisation). We strip
        // the prefix, resolve the underlying route, and re-discriminate the
        // envelope's `kind` so the same dispatch_to_worker_and_stream_chunks
        // helper carries the request through to the worker.
        if let Some(stripped) = path.strip_prefix("/_brust/page") {
            if method != "GET" {
                let _ = s.write_all(http::error_405()).await;
                continue;
            }
            let real_path = if stripped.is_empty() { "/" } else { stripped };
            let (envelope_json, _route_id) = match routes.match_path(&method, real_path, &buf) {
                MatchResult::Matched { envelope_json, route_id } => {
                    let nav_envelope = crate::routes::rewrite_envelope_kind(envelope_json, "navigation");
                    (nav_envelope, route_id)
                }
                MatchResult::NoMatch => {
                    let body = br#"{"error":"not found"}"#.to_vec();
                    let _ = s.write_all(http::build_response(
                        404, "application/json; charset=utf-8", &[], body,
                    )).await;
                    continue;
                }
            };
            match dispatch_to_worker_and_stream_chunks(
                &mut s,
                &pool,
                envelope_json,
                "navigation",
                |_| {},
            ).await {
                DispatchControl::Continue => continue,
                DispatchControl::CloseConn => return,
            }
        }
```

- [ ] **Step 3: Build the Rust side — must compile**

Run from `/Users/detoro/code/brust`:
```
cargo build --lib 2>&1 | tail -5
```
Expected: `Finished` with no errors (warnings about unused are acceptable).

- [ ] **Step 4: Run cargo tests — must still all pass**

Run: `cargo test --lib 2>&1 | tail -3`
Expected: `test result: ok. 93 passed` (unchanged from Task 1 — no new Rust tests in this task; the integration test in Task 5 will exercise this branch end-to-end).

- [ ] **Step 5: Rebuild the native module**

Run:
```
cd /Users/detoro/code/brust/runtime && bun run build:debug 2>&1 | tail -3
```
Expected: `Finished \`dev\` profile [unoptimized + debuginfo] target(s)` with no errors.

- [ ] **Step 6: Smoke the new route returns 404 envelope for unknown paths**

Start a fresh demo server + curl:
```
pkill -9 -f bun 2>/dev/null; sleep 1
cd /Users/detoro/code/brust && BRUST_PORT=38240 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/nav-t2.log 2>&1 &
SERVER_PID=$!
sleep 3
curl -s -i http://127.0.0.1:38240/_brust/page/nonexistent | head -5
kill -9 $SERVER_PID 2>/dev/null; lsof -ti :38240 | xargs -r kill -9 2>/dev/null
```
Expected: `HTTP/1.1 404 Not Found` with `Content-Type: application/json; charset=utf-8` and body `{"error":"not found"}`.

Hitting a real route (e.g., `/_brust/page/`) at this point would dispatch with `kind:'navigation'` but the JS-side branch doesn't exist yet (Task 3) — it would fall through `makeRenderer` to the "unknown kind" 500 path. That's expected at this checkpoint; Task 3 wires it up.

- [ ] **Step 7: Commit**

```bash
cd /Users/detoro/code/brust && git add src/server.rs && git commit -m "$(cat <<'EOF'
feat(server): /_brust/page/ prefix branch routes navigation envelopes

handle_conn intercepts GET /_brust/page/{real_path} BEFORE the general
render-branch route_match. The prefix is stripped, the real path resolved
through the existing routes.match_path, and the envelope's `kind` is
rewritten render → navigation via Task 1's helper. The same
dispatch_to_worker_and_stream_chunks carries the request to the worker —
no cache (on_success is a no-op since navigation responses depend on
per-route render output and shouldn't be cached).

Method other than GET → 405. Unknown route → 404 with JSON envelope
`{"error":"not found"}` so the client interceptor can fall through to
its full-reload fallback uniformly.

JS-side branch (Task 3) is needed before /_brust/page/<real-path> serves
content — until then the worker hits makeRenderer's unknown-kind 500.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: JS-side `navigationBranch`

### Task 3: `RouteCall 'navigation'` variant + `navigationBranch` function

Add the `'navigation'` case to the `RouteCall` discriminated union in `runtime/routes.ts`, branch on it in `makeRenderer`, and implement `navigationBranch` that renders the route synchronously via `renderToString` and ships a JSON `{ html, title }` body. Reuses the existing `buildRenderElement` helper.

**Files:**
- Modify: `/Users/detoro/code/brust/runtime/routes.ts`

- [ ] **Step 1: Extend the `RouteCall` union**

Find the `export type RouteCall =` block (around line 346). It currently lists `'render' | 'action' | 'sse' | 'ws' | 'mcp'` variants. Add a navigation variant with the same fields as the render variant (Rust's helper only swaps the `kind` discriminant — the other fields are identical):

Search for the existing render variant in the union. It looks like:
```typescript
| {
    kind: 'render'
    route_id: number
    path: string
    params: Record<string, string>
    req: BrustRequest
  }
```

Add an identical `'navigation'` variant immediately after it:
```typescript
  | {
      kind: 'navigation'
      route_id: number
      path: string
      params: Record<string, string>
      req: BrustRequest
    }
```

- [ ] **Step 2: Branch on `'navigation'` in `makeRenderer`**

Find `makeRenderer` (around line 408). It contains an `if (call.kind === 'render')` block, then `'action'`, `'mcp'`, `'sse'`, `'ws'`, then the unknown-kind fallback. Insert a new branch AFTER the `'render'` branch and BEFORE the `'action'` branch:

```typescript
    if (call.kind === 'navigation') {
      return navigationBranch(call, byRouteId, view, encoder, opts.getWorkerId)
    }
```

The `byRouteId` map and `encoder` are already in scope from the surrounding `makeRenderer` closure.

- [ ] **Step 3: Add `navigationBranch` function**

Find `buildRenderElement` (around line 559 — search for `async function buildRenderElement`). Insert `navigationBranch` IMMEDIATELY ABOVE it (so both helpers sit together):

```typescript
async function navigationBranch(
  call: Extract<RouteCall, { kind: 'navigation' }>,
  byRouteId: Map<number, FlatRoute>,
  view: Uint8Array,
  encoder: TextEncoder,
  getWorkerId: (() => number | null) | undefined,
): Promise<void> {
  const workerId = BigInt(getWorkerId?.() ?? 0)
  const napi = {
    renderChunk: async (wid: bigint, len: number, _view: Uint8Array): Promise<void> => {
      await (native as any).napiRenderChunk(Number(wid), len)
    },
  }

  const flat = byRouteId.get(call.route_id)
  if (!flat) {
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 404,
      contentType: 'application/json; charset=utf-8',
      body: '{"error":"not found"}',
    })
    return
  }

  try {
    const element = await buildRenderElement(call as any, flat, getWorkerId)
    if (!element) throw new Error('render setup failed')
    const fullHtml = renderToString(element)

    // Extract <main> inner content. If the page didn't render a <main>,
    // ship the full HTML — the client's no-main check will fire its
    // full-reload fallback.
    const mainMatch = fullHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    const innerHtml = mainMatch ? mainMatch[1] : fullHtml

    // Extract <title> text. React 18 inserts <!-- --> markers between
    // adjacent text nodes inside <title>; strip those before serialising.
    const titleMatch = fullHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch
      ? titleMatch[1].replace(/<!--.*?-->/g, '').trim()
      : ''

    const body = JSON.stringify({ html: innerHtml, title })
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body,
    })
  } catch (err) {
    console.error('[brust] navigation render failed:', err)
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 500,
      contentType: 'application/json; charset=utf-8',
      body: '{"error":"render failed"}',
    })
  }
}
```

Notes:
- `import { renderToString } from 'react-dom/server'` — already imported at the top of routes.ts (search to confirm; the render branch uses it for `renderToString` already? Actually no — render uses `renderToPipeableStream`. Check if `renderToString` is imported. If not, add to the existing `react-dom/server` import line.)
- `import * as native from './index.js'` — already imported.

Verify the `react-dom/server` import line. Run:
```
grep -n "react-dom/server" runtime/routes.ts
```
If the import only has `renderToPipeableStream`, change it to `import { renderToPipeableStream, renderToString } from 'react-dom/server'`.

- [ ] **Step 4: Build the runtime — must compile**

Run:
```
cd /Users/detoro/code/brust && bunx tsc --noEmit -p runtime/tsconfig.json 2>&1 | grep -vE "islands/_entries/react.ts" | head -10
```
Expected: no output (only the pre-existing `islands/_entries/react.ts` error is filtered out — that's unrelated module-config noise from before this session).

- [ ] **Step 5: Smoke — /_brust/page/blog/x returns JSON**

```
pkill -9 -f bun 2>/dev/null; sleep 1
cd /Users/detoro/code/brust && BRUST_PORT=38241 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/nav-t3.log 2>&1 &
SERVER_PID=$!
sleep 3
echo "=== JSON body ==="; curl -s http://127.0.0.1:38241/_brust/page/blog/welcome | head -c 300
echo ""
echo "=== Content-Type ==="; curl -s -I http://127.0.0.1:38241/_brust/page/blog/welcome | grep -i content-type
kill -9 $SERVER_PID 2>/dev/null; lsof -ti :38241 | xargs -r kill -9 2>/dev/null
```
Expected:
- Body parses as JSON with `html` + `title` keys
- `html` contains the BlogPost h1 ("BlogPost: Post: welcome")
- `html` does NOT contain `<header>` or `<footer>` (Layout chrome excluded)
- `title` is the page title (ends with `Brust demo`)
- Content-Type is `application/json; charset=utf-8`

- [ ] **Step 6: Run runtime tests — no regression**

Run: `bun test runtime/ 2>&1 | tail -3`
Expected: `98 pass` (unchanged — no new runtime tests in this task; bootstrap tests come in Task 4).

- [ ] **Step 7: Commit**

```bash
cd /Users/detoro/code/brust && git add runtime/routes.ts && git commit -m "$(cat <<'EOF'
feat(routes): navigationBranch + RouteCall 'navigation' variant

JS-side handler for the /_brust/page/{path} navigation envelopes Task 2
landed. navigationBranch reuses buildRenderElement (same path resolution +
loader chain + element construction as render), calls renderToString
synchronously (navigation responses are small enough that the streaming
machinery would add cost for no gain), regex-extracts <main> inner HTML
and <title> text, then ships `{ html, title }` JSON via the existing
single-chunk dispatch.

Missing-<main> path: ship the full HTML; client's no-main check fires
its full-reload fallback. Render error: 500 + JSON envelope so the
client interceptor handles every non-2xx uniformly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Client interceptor + bootstrap refactor

### Task 4: Bootstrap refactor + `swapMainContent` + interceptor + 4 unit tests

Refactor `runtime/islands/bootstrap.ts` to expose `hydrateMarkersIn(root)` (with an idempotence guard), add `swapMainContent`, add the click + popstate interceptor, and ship 4 runtime unit tests.

**Files:**
- Modify: `/Users/detoro/code/brust/runtime/islands/bootstrap.ts`
- Create: `/Users/detoro/code/brust/runtime/islands/bootstrap.test.ts`

- [ ] **Step 1: Write the 4 failing unit tests in a new file**

Create `/Users/detoro/code/brust/runtime/islands/bootstrap.test.ts`:

```typescript
import { test, expect } from 'bun:test'
import { isInternalLink, hydrateMarkersIn } from './bootstrap'

function makeLink(href: string, attrs: Partial<{ target: string; download: string; 'data-brust-no-intercept': string }> = {}): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = href
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) a.setAttribute(k, v)
  }
  return a
}

function plainClick(): MouseEvent {
  return new MouseEvent('click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })
}

test('isInternalLink accepts plain same-origin <a href> on left click with no modifiers', () => {
  const a = makeLink('/blog/welcome')
  expect(isInternalLink(a, plainClick())).toBe(true)
})

test('isInternalLink rejects external origin, _blank, modifier-click, anchor, /_brust/, opt-out, download', () => {
  // External origin
  expect(isInternalLink(makeLink('https://example.com/x'), plainClick())).toBe(false)
  // target=_blank
  expect(isInternalLink(makeLink('/x', { target: '_blank' }), plainClick())).toBe(false)
  // modifier click
  const a = makeLink('/x')
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, metaKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, ctrlKey: true }))).toBe(false)
  // middle-click
  expect(isInternalLink(a, new MouseEvent('click', { button: 1 }))).toBe(false)
  // same-pathname anchor — set location.hash to differ from a.hash
  const anchor = makeLink(`${location.origin}${location.pathname}#section`)
  expect(isInternalLink(anchor, plainClick())).toBe(false)
  // /_brust/ prefix (framework-internal)
  expect(isInternalLink(makeLink('/_brust/page/x'), plainClick())).toBe(false)
  // explicit opt-out
  expect(isInternalLink(makeLink('/x', { 'data-brust-no-intercept': '' }), plainClick())).toBe(false)
  // download
  expect(isInternalLink(makeLink('/file.pdf', { download: '' }), plainClick())).toBe(false)
})

test('hydrateMarkersIn(root) only scans within the given root subtree', () => {
  const outside = document.createElement('div')
  outside.setAttribute('data-brust-island', 'Outside')
  outside.setAttribute('data-brust-props', '{}')
  document.body.appendChild(outside)

  const root = document.createElement('div')
  document.body.appendChild(root)
  const inside = document.createElement('div')
  inside.setAttribute('data-brust-island', 'Inside')
  inside.setAttribute('data-brust-props', '{}')
  root.appendChild(inside)

  hydrateMarkersIn(root)

  // Inside the root: marker should be tagged (idempotence flag set)
  expect(inside.hasAttribute('data-brust-hydrated')).toBe(true)
  // Outside the root: marker should NOT be tagged
  expect(outside.hasAttribute('data-brust-hydrated')).toBe(false)

  // Cleanup
  document.body.removeChild(outside)
  document.body.removeChild(root)
})

test('hydrateMarkersIn is idempotent — second call on same root does not re-tag', () => {
  const root = document.createElement('div')
  const marker = document.createElement('div')
  marker.setAttribute('data-brust-island', 'X')
  marker.setAttribute('data-brust-props', '{}')
  root.appendChild(marker)
  document.body.appendChild(root)

  hydrateMarkersIn(root)
  expect(marker.getAttribute('data-brust-hydrated')).toBe('1')

  // Mutate the attribute to detect re-tagging. If the second call processes
  // already-hydrated markers, it would overwrite this value back to '1'.
  marker.setAttribute('data-brust-hydrated', 'seen')
  hydrateMarkersIn(root)
  expect(marker.getAttribute('data-brust-hydrated')).toBe('seen')

  document.body.removeChild(root)
})
```

- [ ] **Step 2: Run tests — must FAIL ("Module './bootstrap' has no exported member 'isInternalLink'")**

Run from `/Users/detoro/code/brust`:
```
bun test runtime/islands/bootstrap.test.ts 2>&1 | tail -10
```
Expected: import error / undefined `isInternalLink` / undefined `hydrateMarkersIn`.

- [ ] **Step 3: Refactor `runtime/islands/bootstrap.ts` with the full implementation**

REPLACE the entire contents of `runtime/islands/bootstrap.ts` with:

```typescript
// Brust client-side hydration bootstrap.
// Built once at boot into .brust/islands/_bootstrap.js and served at
// /_brust/islands/_bootstrap.js. Loaded by makeRenderer-injected <script>.
//
// Responsibilities:
//   1. Hydrate every <... data-brust-island="<id>" ...> marker under a
//      given root (default: document.body) — exposed as hydrateMarkersIn
//      so the navigation interceptor can re-run it on the new <main>
//      after a navigation swap.
//   2. Intercept internal <a href> clicks → fetch /_brust/page/{path} →
//      swap <main> in place → update title → re-hydrate islands →
//      history.pushState. Any failure falls back to a full reload.
//   3. Listen for popstate (back / forward) and run the same swap path
//      without pushing a new entry.

import { hydrateRoot } from 'react-dom/client'
import { createElement } from 'react'

type Trigger = 'load' | 'idle' | 'visible' | 'interaction'

function registerTrigger(el: HTMLElement, trigger: Trigger, fire: () => void): void {
  switch (trigger) {
    case 'load': {
      fire()
      return
    }
    case 'idle': {
      const rIC = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
      if (typeof rIC === 'function') {
        rIC(fire)
      } else {
        setTimeout(fire, 0)
      }
      return
    }
    case 'visible': {
      if (typeof IntersectionObserver === 'undefined') {
        fire()
        return
      }
      const io = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            obs.disconnect()
            fire()
            return
          }
        }
      })
      io.observe(el)
      return
    }
    case 'interaction': {
      const onceFire = () => {
        el.removeEventListener('pointerdown', onceFire)
        el.removeEventListener('keydown', onceFire)
        el.removeEventListener('focusin', onceFire)
        fire()
      }
      el.addEventListener('pointerdown', onceFire, { once: false })
      el.addEventListener('keydown', onceFire, { once: false })
      el.addEventListener('focusin', onceFire, { once: false })
      return
    }
  }
}

async function hydrateOne(el: HTMLElement): Promise<void> {
  const id = el.getAttribute('data-brust-island')
  if (!id) return
  const propsJson = el.getAttribute('data-brust-props') ?? '{}'
  let props: Record<string, unknown>
  try {
    props = JSON.parse(propsJson)
  } catch (e) {
    console.error(`[brust] island "${id}": invalid data-brust-props JSON`, e)
    return
  }
  try {
    const mod = await import(`/_brust/islands/${id}.js`)
    const Component = (mod.default ?? mod) as React.ComponentType<Record<string, unknown>>
    if (typeof Component !== 'function') {
      console.error(`[brust] island "${id}": chunk has no default-exported component`)
      return
    }
    hydrateRoot(el, createElement(Component, props))
  } catch (e) {
    console.error(`[brust] island "${id}": hydration failed`, e)
  }
}

/** Scan `root` for un-hydrated island markers and register their hydration
 * triggers. Exposed so the navigation interceptor can call it on the
 * freshly-swapped <main> subtree after a SPA navigation. The
 * `data-brust-hydrated` attribute on each marker is the idempotence guard
 * — a second call on the same root no-ops for already-hydrated markers. */
export function hydrateMarkersIn(root: ParentNode = document.body): void {
  const markers = root.querySelectorAll<HTMLElement>('[data-brust-island]:not([data-brust-hydrated])')
  for (const el of Array.from(markers)) {
    el.setAttribute('data-brust-hydrated', '1')
    const trig = (el.getAttribute('data-brust-hydrate') ?? 'load') as Trigger
    registerTrigger(el, trig, () => {
      void hydrateOne(el)
    })
  }
}

/** Replace `main`'s children with HTML from a trusted Brust server
 * response. The trust boundary is documented in the design spec:
 * the HTML originates from the same Brust server that produced the
 * initial page load, parsed by the standard browser HTML parser
 * exactly as the initial response was. No untrusted user input enters
 * this code path. */
export function swapMainContent(main: HTMLElement, html: string): void {
  const range = document.createRange()
  range.selectNodeContents(main)
  range.deleteContents()
  const fragment = range.createContextualFragment(html)
  main.appendChild(fragment)
}

/** Classifier — true iff the event should be intercepted as a SPA
 * navigation. Exported for unit testing. */
export function isInternalLink(a: HTMLAnchorElement, event: MouseEvent): boolean {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  if (a.target && a.target !== '_self') return false
  if (a.hasAttribute('download')) return false
  if (a.dataset.brustNoIntercept !== undefined) return false
  const url = new URL(a.href, location.href)
  if (url.origin !== location.origin) return false
  if (url.pathname === location.pathname && url.hash) return false
  if (url.pathname.startsWith('/_brust/')) return false
  return true
}

let inFlight: AbortController | null = null

async function navigate(url: URL, push: boolean): Promise<void> {
  inFlight?.abort()
  const ac = new AbortController()
  inFlight = ac
  try {
    const resp = await fetch(`/_brust/page${url.pathname}${url.search}`, {
      signal: ac.signal,
      headers: { 'Accept': 'application/json' },
    })
    if (!resp.ok) throw new Error(`navigation: status ${resp.status}`)
    const { html, title } = await resp.json() as { html: string; title: string }
    const main = document.querySelector('main')
    if (!main) throw new Error('navigation: no <main> element')
    swapMainContent(main as HTMLElement, html)
    if (title) document.title = title
    if (push) history.pushState({}, '', url.href)
    window.scrollTo(0, 0)
    hydrateMarkersIn(main as HTMLElement)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    console.warn('[brust] SPA navigation failed, falling back to full reload:', err)
    location.href = url.href
  } finally {
    if (inFlight === ac) inFlight = null
  }
}

function installInterceptor(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null
    const a = target?.closest('a') as HTMLAnchorElement | null
    if (!a || !isInternalLink(a, e)) return
    e.preventDefault()
    void navigate(new URL(a.href, location.href), /* push */ true)
  })
  window.addEventListener('popstate', () => {
    void navigate(new URL(location.href), /* push */ false)
  })
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      hydrateMarkersIn(document.body)
      installInterceptor()
    })
  } else {
    hydrateMarkersIn(document.body)
    installInterceptor()
  }
}
```

- [ ] **Step 4: Run unit tests — must pass**

Run: `bun test runtime/islands/bootstrap.test.ts 2>&1 | tail -10`
Expected: `4 pass`.

- [ ] **Step 5: Run full runtime suite — no regression**

Run: `bun test runtime/ 2>&1 | tail -3`
Expected: `102 pass` (98 prior + 4 new).

- [ ] **Step 6: Smoke — demo loads, browser navigation works**

```
pkill -9 -f bun 2>/dev/null; sleep 1
cd /Users/detoro/code/brust && BRUST_PORT=38242 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/nav-t4.log 2>&1 &
SERVER_PID=$!
sleep 3
# Verify the bootstrap chunk now contains the interceptor symbols
curl -s http://127.0.0.1:38242/_brust/islands/_bootstrap.js | grep -oE "isInternalLink|hydrateMarkersIn|swapMainContent|popstate" | sort -u
kill -9 $SERVER_PID 2>/dev/null; lsof -ti :38242 | xargs -r kill -9 2>/dev/null
```
Expected output (all 4 symbols present, plus possibly minified variants):
```
hydrateMarkersIn
isInternalLink
popstate
swapMainContent
```
(Minified builds may rename these — if no match, run `cd runtime && bun run build:debug` since the boot pipeline builds the chunk fresh each server start.)

- [ ] **Step 7: Commit**

```bash
cd /Users/detoro/code/brust && git add runtime/islands/bootstrap.ts runtime/islands/bootstrap.test.ts && git commit -m "$(cat <<'EOF'
feat(islands): SPA navigation interceptor + hydrateMarkersIn refactor

Refactors the existing bootstrap script's init loop into an exported
hydrateMarkersIn(root: ParentNode = document.body) so the navigation
interceptor can re-run it on the freshly-swapped <main> after a SPA
navigation. Adds a data-brust-hydrated idempotence guard so calling
hydrateMarkersIn twice on the same root no-ops for already-hydrated
markers.

New swapMainContent(main, html) helper uses Range + createContextualFragment
to replace the <main> element's children with HTML from a trusted Brust
server response (the same trust assumption as the initial server render).

New isInternalLink(a, event) classifier (exported for unit testing)
encodes the 8-way bypass matrix from the spec — external origin,
target=_blank, modifier keys, middle-click, same-pathname anchors,
/_brust/* paths, data-brust-no-intercept opt-out, and <a download>
all fall through to default browser behaviour.

navigate(url, push) handles the fetch + swap + history pushState
flow. inFlight AbortController cancels stale requests on rapid clicks.
Any failure (network error, non-2xx, JSON parse, missing <main>,
unexpected throws) silently falls back to `location.href = url`.

popstate handler reruns the same flow with push=false so back/forward
buttons get SPA-style swaps too.

4 runtime unit tests cover: positive classifier path, 8-way bypass
rejection, hydrateMarkersIn scoping (no leaks outside the root),
idempotence guard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: Integration tests + demo verification

### Task 5: 3 integration tests at ports 38240-38242

Add three end-to-end tests for the new `/_brust/page/` route — exact JSON shape on a happy path, 404 envelope on an unmatched path, and the `<main>`-missing fallback (page that doesn't render `<main>` falls back to shipping the full HTML in `html`).

**Files:**
- Modify: `/Users/detoro/code/brust/tests/integration.test.ts`

- [ ] **Step 1: Append the 3 tests at the end of `tests/integration.test.ts`**

Run `grep -n "STREAM_ENV\|tail -n 5 tests/integration.test.ts" tests/integration.test.ts | tail -3` to find a near-end anchor — confirm the file ends in a streaming-test test() block. Append AFTER the last existing test:

```typescript
// ----- Navigation interceptor integration tests -----

const NAV_ENV = (port: string) => ({
  ...process.env,
  BRUST_PORT: port,
  BRUST_WORKERS: '1',
  RUST_LOG: 'brust=warn',
})

test('nav: /_brust/page/blog/x returns JSON {html, title} with <main> inner only', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: NAV_ENV('38240'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/blog/welcome`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type') ?? '').toContain('application/json')
    const body = await resp.json() as { html: string; title: string }
    expect(typeof body.html).toBe('string')
    expect(typeof body.title).toBe('string')
    // <main> chrome excluded — no header/footer literals
    expect(body.html).not.toContain('<header')
    expect(body.html).not.toContain('<footer')
    // Page-specific content present
    expect(body.html).toContain('Post: welcome')
    expect(body.html).toContain('welcome')
    // Title carries the page name
    expect(body.title.length).toBeGreaterThan(0)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('nav: /_brust/page/<unknown> returns 404 with JSON error envelope', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: NAV_ENV('38241'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/this/path/does/not/exist`)
    expect(resp.status).toBe(404)
    expect(resp.headers.get('content-type') ?? '').toContain('application/json')
    const body = await resp.json() as { error: string }
    expect(body.error).toBe('not found')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('nav: page without <main> falls back to shipping full HTML in html field', async () => {
  // The fixture's /crash route renders the CrashBoundary, which is a bare
  // <div>Crashed: ...</div> — no <main> wrapper. The navigation branch
  // should detect the missing <main> and ship the full rendered HTML
  // instead, so the client interceptor can fire its no-main fallback.
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: NAV_ENV('38242'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/crash`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type') ?? '').toContain('application/json')
    const body = await resp.json() as { html: string; title: string }
    expect(body.html.length).toBeGreaterThan(0)
    // Full HTML fallback — no <main> in the response either, but the
    // CrashBoundary content is present.
    expect(body.html).not.toContain('<main')
    expect(body.html).toContain('CrashBoundary')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)
```

- [ ] **Step 2: Run only the 3 new nav tests**

Run from `/Users/detoro/code/brust`:
```
bun test tests/integration.test.ts --test-name-pattern "nav:" 2>&1 | tail -10
```
Expected: `3 pass, 0 fail`.

If test 3 (missing-main fallback) fails because the fixture's CrashBoundary actually IS inside a `<main>` (via a Layout import), inspect the CrashBoundary component in `tests/fixtures/app/components/CrashBoundary.tsx` and pick a different route whose rendered HTML genuinely has no `<main>`. Adjust the test's route + assertion text accordingly. Don't weaken the assertion to make it pass.

- [ ] **Step 3: Run the full integration suite — no regression**

Run: `bun test tests/integration.test.ts 2>&1 | tail -5`
Expected: `69 pass, 0 fail` (66 baseline + 3 new).

- [ ] **Step 4: Commit**

```bash
cd /Users/detoro/code/brust && git add tests/integration.test.ts && git commit -m "$(cat <<'EOF'
test(integration): 3 navigation interceptor tests at ports 38240-38242

- JSON shape on happy path: /_brust/page/blog/welcome returns 200 +
  application/json + body { html, title }, html does NOT contain
  <header>/<footer> (Layout chrome excluded), html DOES contain the
  page-specific h1 text, title is non-empty.
- 404 envelope for unmatched path: /_brust/page/this/path/does/not/exist
  returns 404 + application/json + body {"error":"not found"} so the
  client interceptor can handle it uniformly.
- Missing-<main> fallback: a route whose render output has no <main>
  ships the full rendered HTML in the html field; the client's
  no-main check fires its full-reload fallback.

Total integration tests: 69 (66 baseline + 3 navigation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Demo browser smoke + architecture.md promotion

End-to-end verification using the example app (manual smoke + automated checks) + promote Navigation to the Built list in `architecture.md`.

**Files:**
- Modify: `/Users/detoro/code/brust/architecture.md`

- [ ] **Step 1: Manual demo smoke**

```
pkill -9 -f bun 2>/dev/null; sleep 1
cd /Users/detoro/code/brust && BRUST_PORT=38250 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/nav-smoke.log 2>&1 &
SERVER_PID=$!
sleep 3
echo "=== nav 1: / "; curl -s -i http://127.0.0.1:38250/_brust/page/ | head -2
echo "=== nav 2: /blog/welcome "; curl -s -i http://127.0.0.1:38250/_brust/page/blog/welcome | head -2
echo "=== nav 3: /slow-suspense "; curl -s -i http://127.0.0.1:38250/_brust/page/slow-suspense | head -2
echo "=== nav 4: /profile/world "; curl -s -i http://127.0.0.1:38250/_brust/page/profile/world | head -2
echo "=== bootstrap chunk has interceptor ==="; curl -s http://127.0.0.1:38250/_brust/islands/_bootstrap.js | grep -cE "isInternalLink|popstate|hydrateMarkersIn"
kill -9 $SERVER_PID 2>/dev/null; lsof -ti :38250 | xargs -r kill -9 2>/dev/null
```

Expected: all 4 navigation responses return `HTTP/1.1 200 OK`, the bootstrap chunk grep count is at least 3 (one for each symbol — may be more if names appear multiple times).

- [ ] **Step 2: Promote Navigation to the Built list in `architecture.md`**

Find the existing line in the "Designed, not built" section (search for `Navigation (intercept Link`):
```
- Navigation (intercept Link, JSON page fetches over `/_brust/page/*`)
```
Delete that line.

Find the existing `### Navigation` section (around line 790). Update its opening paragraph from the design sketch to a shipped description. Replace the existing block:

```
### Navigation

```
User clicks <Link to="/blog/next">
  → intercept click
  → GET /_brust/page/blog/next      JSON: { html, islands, head }
  → swap <div id="root">; update <title>/<meta>
  → re-wire island hydration triggers on the new DOM
  → pushState
```
```

With:

```
### Navigation

**Shipped.** Plain `<a href>` clicks are intercepted by the bootstrap
chunk; internal same-origin navigations fetch
`GET /_brust/page/{path}` for a JSON `{ html, title }` envelope and
swap the `<main>` element's children in place, update `document.title`,
re-hydrate any new islands, and `history.pushState` the URL.
Back/forward buttons reuse the same swap path via `popstate`. Any
failure (network error, non-2xx response, missing `<main>`, malformed
JSON) silently falls back to `location.href = url`, so the user always
navigates. External links, `target="_blank"`, modifier-clicks,
same-page anchors, `/_brust/*` framework paths, and links with
`data-brust-no-intercept` all use default browser behaviour. Shipped
in 2026-05.

Spec: `docs/superpowers/specs/2026-05-26-navigation-interceptor-design.md`.
Implementation plan: `docs/superpowers/plans/2026-05-26-navigation-interceptor.md`.
```

Find the Built list (search for the HTML Streaming entry added in the previous session). Add a NEW bullet right AFTER HTML Streaming:

```
- Navigation interceptor (`/_brust/page/*` JSON page fetches) — Global `<a>` click interceptor (zero markup change) on the bootstrap chunk converts internal same-origin navigations into `GET /_brust/page/{path}` fetches that return a JSON `{ html, title }` envelope. Rust's `handle_conn` strips the `/_brust/page/` prefix, resolves the route through the existing `routes.match_path`, and rewrites the envelope's `kind` from `"render"` to `"navigation"` via `rewrite_envelope_kind` — same dispatch helper as render, same per-worker render slot. JS-side `navigationBranch` renders synchronously via `renderToString` and regex-extracts `<main>` inner content + `<title>` text (React 18 `<!-- -->` markers stripped). Client swap uses `Range.createContextualFragment` to parse the trusted server response (same trust boundary as the initial server render) and replace `<main>`'s children, then re-runs `hydrateMarkersIn(main)` (refactored from the existing init loop with a `data-brust-hydrated` idempotence guard). `pushState` on click, `popstate` on back/forward. Every failure mode (network error, non-2xx, missing `<main>`, JSON parse error, render error) silently falls back to `location.href = url` — user always navigates. Rapid clicks abort in-flight fetches via `AbortController` so only the last click wins. No author API change — demo Layout's `<main>` + nav links become SPA automatically. Deferred: prefetch on hover, View Transitions API, scroll restoration, `<Link>` component, POST navigation.
```

- [ ] **Step 3: Final baseline — all three suites must pass**

Run from `/Users/detoro/code/brust`:
```
cargo test --lib 2>&1 | tail -3
bun test runtime/ 2>&1 | tail -3
bun test tests/integration.test.ts 2>&1 | tail -3
```
Expected:
- Rust: `93 passed`
- Runtime: `102 pass`
- Integration: `69 pass`

- [ ] **Step 4: Commit + push**

```bash
cd /Users/detoro/code/brust && git add architecture.md && git commit -m "$(cat <<'EOF'
docs(architecture): Navigation interceptor shipped — promote to Built list

Plain `<a href>` clicks on internal same-origin links are now
intercepted by the bootstrap chunk and converted into JSON page
fetches via /_brust/page/{path}. The server reuses the existing
render pipeline (rewrite_envelope_kind swaps the envelope's
discriminant); the client swaps <main>'s children via
Range.createContextualFragment, updates document.title, re-runs
hydrateMarkersIn on the new subtree, and pushState's the URL.

Every failure mode degrades to `location.href = url` so the user
always navigates. External, modifier-click, target=_blank, anchors,
/_brust/* paths, and data-brust-no-intercept opt-outs all use default
browser behaviour.

Final test count: 93 Rust + 102 runtime + 69 integration (was
90 + 98 + 66 at the start of this implementation chain) — 10 new
tests across the 6-task implementation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)" && git push origin main 2>&1 | tail -3
```

---

## Spec coverage check (self-review)

| Spec S | Implementing tasks |
|---|---|
| S1 success criterion 1 (demo SPA nav, no full reload) | Task 4 + Task 6 manual smoke |
| S1 success criterion 2 (back/forward) | Task 4 (popstate handler) |
| S1 success criterion 3 (islands re-hydrate) | Task 4 (`hydrateMarkersIn(main)` after swap) |
| S1 success criterion 4 (external + special links bypass) | Task 4 (`isInternalLink`) + runtime test #2 |
| S1 success criterion 5 (graceful fallback) | Task 4 (try/catch → `location.href`) |
| S1 success criterion 6 (concurrent clicks abort) | Task 4 (`inFlight.abort()`) |
| S1 success criterion 7 (no regression) | Task 6 final baseline check |
| S2 Architecture | Tasks 1-4 (rewrite helper, server branch, JS branch, client interceptor) |
| S3 Module layout | Task 1+2 (server.rs + routes.rs), Task 3 (routes.ts), Task 4 (bootstrap.ts + bootstrap.test.ts) |
| S4 Wire protocol (request URL + JSON shape + cache policy) | Task 2 (URL routing + 404 envelope) + Task 3 (JSON serialisation) |
| S5 Rust-side branch + `rewrite_envelope_kind` | Task 1 (helper) + Task 2 (branch) |
| S6 JS `navigationBranch` + RouteCall variant | Task 3 |
| S7 Bootstrap refactor + `swapMainContent` + interceptor + matrix | Task 4 |
| S8 Error matrix | Task 4 (`try/catch` in `navigate`) covers 9 cases; integration tests 2 + 3 verify the 2 server-side error cases |
| S9 Testing (4 runtime + 3 integration + 1 Rust) | Task 1 (Rust × 3 — covers `rewrite_envelope_kind`), Task 4 (runtime × 4), Task 5 (integration × 3) |
| S10 Limits & deferred | (documented in spec; no impl task) |

All S1-S9 spec requirements map to at least one task.

## Type / name consistency check

| Identifier | Defined in task | Used in tasks |
|---|---|---|
| `rewrite_envelope_kind` (Rust) | Task 1 (`src/routes.rs`) | Task 2 (`handle_conn` branch) |
| `RouteCall { kind: 'navigation', ... }` | Task 3 (`runtime/routes.ts`) | Task 3 (`makeRenderer` branch + `navigationBranch` signature) |
| `navigationBranch` | Task 3 | Task 3 (called from `makeRenderer`) |
| `hydrateMarkersIn(root)` | Task 4 (`runtime/islands/bootstrap.ts`) | Task 4 (called by `navigate` + initial-load entry) |
| `swapMainContent(main, html)` | Task 4 | Task 4 (called by `navigate`) |
| `isInternalLink(a, event)` | Task 4 | Task 4 (interceptor + runtime tests) |
| `data-brust-hydrated` attribute | Task 4 (idempotence guard) | Task 4 (runtime test #4) |
| `data-brust-no-intercept` attribute | Task 4 (`isInternalLink`) | Task 4 (runtime test #2 bypass case) |
| `/_brust/page/` URL prefix | Task 2 (`handle_conn`) | Task 4 (`fetch` URL) + Task 5 (integration tests) |
| `{ html, title }` JSON shape | Task 3 (server emits) | Task 4 (client parses) + Task 5 (assertion shape) |

All cross-references resolved.

---

**Total: 6 tasks; ~6-8 hours engineering; 4 runtime unit + 3 integration + 3 Rust = 10 new tests → 264 total.**

---

## Follow-up corrections (T7, 2026-05-26)

Final whole-chain review of the shipped navigation interceptor (commits dbe7300..a024b32) identified two correctness gaps that were addressed in a follow-up commit.

### Task 3 correction — `navigationBranch` must run the middleware chain

The original Task 3 implementation skipped `composeChain` in `navigationBranch`. This was a security gap: auth-guarded routes (e.g., `/admin/dashboard` with `authRequired` middleware) would return their rendered content through `/_brust/page/{path}` even without the required cookie.

**Correction shipped in T7:** `navigationBranch` now mirrors the render branch's middleware pattern — `composeChain` runs with a `Symbol.for('brust.streamRender')` marker terminal, the verdict is awaited, and a short-circuit verdict (status, body, headers from middleware) is emitted as the navigation response. The client treats any non-2xx as a fallback trigger and reloads, so the user sees the middleware's challenge at the real URL. Middleware throws emit a 500 JSON envelope.

A new integration test (port 38243) verifies that `/_brust/page/admin/dashboard` without a cookie returns 401 and does not leak the rendered admin content. Total integration tests: 70 (was 69).

### Task 4 correction — `swapMainContent` uses `DOMParser + importNode`

The original Task 4 implementation used `Range.createContextualFragment`. The shipped T4 fixup switched to `DOMParser('text/html') + importNode` (the inert-parse approach, where scripts in the fragment are not executed during parsing). The trust-boundary commentary is preserved. Spec S7 has been updated to show the correct implementation.
