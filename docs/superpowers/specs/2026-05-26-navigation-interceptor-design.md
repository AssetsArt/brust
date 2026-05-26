# Navigation Interceptor — Design

**Status:** Spec ready · execution pending plan
**Scope:** Convert plain `<a href>` clicks into JSON page fetches that swap the `<main>` element in place, update `document.title`, re-hydrate any new islands, and push the URL onto the history stack. No new author API — the existing demo Layout's `<main>` + nav links automatically become SPA-style after the bootstrap script ships the new code. Failure of any kind degrades gracefully to a full reload.
**Tier-2 line item:** Navigation (`intercept Link, JSON page fetches over /_brust/page/*`) — `architecture.md:989`.
**Predecessor design hints:** `architecture.md:790-799` (informal sketch; this spec is the formal commitment).
**Trust boundary:** The swapped HTML originates from the same Brust server that produced the initial page load. Treating it as trusted markup (parse-and-mount via the standard DOM API) is the same trust assumption the initial server-rendered response already relies on — XSS in server-rendered React would propagate either way. No untrusted user-supplied HTML enters this code path.

---

## 1. Goal & success criteria

Authors do nothing different. Pages that use the demo's `<Layout>` (or any layout that wraps content in `<main>`) get SPA-style navigation for free — clicking any internal `<a href>` swaps the `<main>` content without a full reload.

```tsx
// Author code — UNCHANGED
<a href="/blog/welcome">Read the welcome post</a>

// Runtime behaviour — NEW
// 1. Click intercepted by the bootstrap script
// 2. fetch GET /_brust/page/blog/welcome → { html, title }
// 3. swapMainContent(main, json.html)
// 4. document.title = title
// 5. islands in the new <main> re-hydrate
// 6. history.pushState({}, '', '/blog/welcome')
```

**Success criteria (must hold after the final task of the implementation plan):**

1. **Demo SPA navigation** — Clicking any of the four nav links in the demo's Layout (`/`, `/blog/welcome`, `/slow-suspense`, `/profile/world`) swaps the `<main>` content in place, updates the title, and pushes the URL. No full reload (verified by `performance.getEntriesByType('navigation').length` staying at 1).
2. **Back/forward** — Browser back/forward buttons trigger the same JSON fetch + swap path; URL and content stay consistent.
3. **Islands re-hydrate** — Navigating to a page that uses islands (e.g., `/` with `<Counter />`) re-hydrates them after swap; the counter responds to clicks immediately.
4. **External + special links bypass** — Links with `target="_blank"`, modifier keys (Cmd/Ctrl/Shift/Alt+click), `data-brust-no-intercept`, same-page anchors (`href="#x"`), `/_brust/*` paths, and external origins all use default browser behaviour (full reload / new tab / scroll).
5. **Graceful fallback** — Any failure (network error, non-2xx response, missing `<main>`, malformed JSON) silently falls back to `location.href = url.href`. User sees a brief delay but the navigation always succeeds.
6. **Concurrent clicks** — Rapid clicks abort in-flight requests; only the last click's response wins.
7. **No regression** — All 90 Rust + 98 runtime + 66 integration tests pass unchanged; the new JSON route + bootstrap additions add 4 runtime + 3 integration tests on top.

## 2. Architecture

Three pieces fit together:

```
Browser                              Rust (tokio)                       JS worker
───────                              ─────────────                      ─────────

<a href="/blog/x">                  handle_conn:
       │                              - sees /_brust/page/ prefix
   click event                        - strips prefix → resolves /blog/x
       │                              - dispatches with kind:'navigation'
   intercepted by                                  ───────────►  makeRenderer:
   runtime/islands/bootstrap.ts                                    - branches on kind:'navigation'
       │                                                           - navigationBranch()
   fetch(/_brust/page/blog/x)                                        - renderToString(element)
       ───────────────────────►                                      - regex-extract <main> inner + <title> text
                                                                     - JSON { html, title }
                                                                     - emitSingleChunkResponse
                                                  ◄───────────
                                    - writes JSON via single-chunk path
       ◄───────────────────────
   - swapMainContent(main, json.html)  ◄── parses + replaces main's children
   - document.title = json.title
   - hydrateMarkersIn(main)            ◄── extracted from existing init logic
   - history.pushState(.., '/blog/x')

   popstate event → same fetch + swap, push=false
```

**Why this shape:**
- The same render pipeline produces full-HTML responses for first loads AND extracted-`<main>` responses for navigations. Only the post-render serialisation differs.
- The `/_brust/page/` URL prefix keeps Rust's route table untouched (no new registration, no per-route metadata) — every existing route is navigable.
- `hydrateMarkersIn(root)` is a refactor of the current init code, not new logic — keeps a single hydration code path.
- Failure handling is one branch: any thrown error → `location.href = url`. No error UI, no toast, no state.

## 3. Module layout

```
src/
└── server.rs                       # +`/_brust/page/` prefix branch in handle_conn

runtime/
├── routes.ts                       # +navigationBranch + RouteCall 'navigation' variant
└── islands/
    └── bootstrap.ts                # refactor: extract hydrateMarkersIn(root); +interceptor + swapMainContent helper
```

No new files. The new behaviour ships inside the existing bootstrap chunk and the existing routes module — no extra HTTP request from the client.

## 4. Wire protocol

**Request:** `GET /_brust/page/{path}` where `{path}` is the user-facing route path (e.g., `/_brust/page/blog/welcome` maps to `/blog/welcome`). Standard HTTP/1.1; no special headers required.

**Response (success):** `200 OK` with `Content-Type: application/json; charset=utf-8`. Body:

```jsonc
{
  "html": "<h1>Post: welcome</h1><p>...</p>",  // <main> inner content
  "title": "Post: welcome · Brust demo"         // <title> text content
}
```

**Response (route not matched):** `404 Not Found` with `Content-Type: application/json; charset=utf-8`. Body: `{"error":"not found"}`. The client interceptor treats any non-2xx as a fallback trigger (full reload).

**Response (render error):** `500 Internal Server Error` with `Content-Type: application/json; charset=utf-8`. Body: `{"error":"render failed"}`. Same fallback behaviour client-side.

**Content extraction (server-side regex):**
- `<main[^>]*>([\s\S]*?)<\/main>` → `html` field. If no match (page has no `<main>`), fall back to the full rendered HTML. Client then can't find `<main>` to swap, fires its fallback.
- `<title[^>]*>([\s\S]*?)<\/title>` → `title` field. React 18 emits `<!-- -->` markers inside `<title>` for adjacent text nodes; strip those before serialising.

**Cache layer:** navigation responses are NOT cached (the cache key includes the full path; `/_brust/page/x` and `/x` are different keys). Authors can still mark the underlying route as `cache: { ttl_seconds }` — that cache fires on direct `/x` hits, not on `/_brust/page/x`.

## 5. Rust-side route branch

In `handle_conn` (`src/server.rs`), add a branch BEFORE the general route match (which serves render requests) but AFTER the framework routes (`/_brust/cache/*`, `/_brust/action/*`, `/_brust/islands/*`, `/_brust/mcp`). Position matters: putting it before render-match means navigation requests never accidentally fall into the regular render path.

```rust
if let Some(stripped) = path.strip_prefix("/_brust/page") {
    if method != "GET" {
        let _ = s.write_all(http::error_405()).await;
        continue;
    }
    let real_path = if stripped.is_empty() { "/" } else { stripped };
    let (envelope_json, _route_id) = match routes.match_path(&method, real_path, &buf) {
        MatchResult::Matched { envelope_json, route_id } => {
            let navigation_envelope = rewrite_envelope_kind(envelope_json, "navigation");
            (navigation_envelope, route_id)
        }
        MatchResult::NoMatch => {
            let body = br#"{"error":"not found"}"#.to_vec();
            let _ = s.write_all(http::build_response(
                404, "application/json; charset=utf-8", &[], body,
            )).await;
            continue;
        }
    };
    match dispatch_to_worker_and_stream_chunks(&mut s, &pool, envelope_json, "navigation", |_| {}).await {
        DispatchControl::Continue => continue,
        DispatchControl::CloseConn => return,
    }
}
```

**`rewrite_envelope_kind` helper** (in `src/routes.rs` next to other envelope helpers):

```rust
/// Swap "kind":"render" → "kind":"<new>" in a JSON envelope string.
/// The envelope is JS-built JSON so the field order is stable; we do a
/// targeted substring replace rather than a full parse-rewrite-serialise
/// round-trip.
fn rewrite_envelope_kind(envelope_json: String, new_kind: &str) -> String {
    envelope_json.replacen(r#""kind":"render""#, &format!(r#""kind":"{}""#, new_kind), 1)
}
```

Unit-testable as a pure function. Edge case: if the envelope doesn't contain `"kind":"render"` (shouldn't happen — route_match always builds render envelopes), the original string is returned unchanged and the JS side falls through the render branch normally. Defensive.

## 6. JS-side `navigationBranch`

New branch in `makeRenderer` (`runtime/routes.ts`):

```typescript
if (call.kind === 'navigation') {
  return navigationBranch(call, byRouteId, view, encoder, opts.getWorkerId)
}
```

`navigationBranch` MUST run the middleware chain (via `composeChain`) before calling `buildRenderElement` — otherwise auth-guarded routes would leak their content via the JSON envelope. It reuses the same stream-marker terminal pattern as the render branch: if middleware short-circuits, the verdict (status + body + headers) is emitted directly and the client's non-2xx check triggers a full-reload fallback so the user hits the real middleware challenge. Only if the marker comes back through does the function proceed to `buildRenderElement` + `renderToString`.

```typescript
async function navigationBranch(
  call: NavigationCall, byRouteId, view, encoder, getWorkerId,
): Promise<void> {
  const flat = byRouteId.get(call.route_id)
  if (!flat) {
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 404, contentType: 'application/json; charset=utf-8',
      body: '{"error":"not found"}',
    })
    return
  }

  // Run middleware chain BEFORE rendering — same stream-marker pattern as the
  // render branch. Short-circuit verdict → emit as navigation response (client
  // sees non-2xx → full-reload fallback). Middleware throw → 500 JSON envelope.
  const NAV_MARKER = Symbol.for('brust.streamRender')
  const navChain = composeChain(call.req, flat.middleware, async () => ({
    status: 200, body: '', contentType: 'application/json; charset=utf-8',
    _brustStream: NAV_MARKER,
  }))
  let verdict
  try {
    verdict = await navChain()
  } catch (err) {
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 500, contentType: 'application/json; charset=utf-8',
      body: '{"error":"middleware threw"}',
    })
    return
  }
  if (verdict._brustStream !== NAV_MARKER) {
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: verdict.status,
      contentType: verdict.contentType ?? 'application/json; charset=utf-8',
      body: verdict.body,
      headers: verdict.headers,
    })
    return
  }

  try {
    const element = await buildRenderElement(call, flat, getWorkerId)
    if (!element) throw new Error('render setup failed')
    const fullHtml = renderToString(element)
    const mainMatch = fullHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    const innerHtml = mainMatch ? mainMatch[1] : fullHtml
    const titleMatch = fullHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch
      ? titleMatch[1].replace(/<!--.*?-->/g, '').trim()
      : ''
    const body = JSON.stringify({ html: innerHtml, title })
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 200, contentType: 'application/json; charset=utf-8', body,
    })
  } catch (err) {
    console.error('[brust] navigation render failed:', err)
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 500, contentType: 'application/json; charset=utf-8',
      body: '{"error":"render failed"}',
    })
  }
}
```

**`RouteCall` variant** (`runtime/routes.ts`):

```typescript
export type RouteCall =
  | { kind: 'render', /* ... existing render fields */ }
  | { kind: 'action', /* ... */ }
  | { kind: 'sse', /* ... */ }
  | { kind: 'ws', /* ... */ }
  | { kind: 'mcp', /* ... */ }
  | { kind: 'navigation', route_id: number, path: string, params: Record<string, string>, req: BrustRequest }
```

The navigation variant has the SAME fields as render — Rust's `rewrite_envelope_kind` only changes the `kind` discriminant.

## 7. Client interceptor + island re-hydration

**Refactor `runtime/islands/bootstrap.ts`** — extract the existing markers-scan-and-hydrate loop into a reusable function, exported from the module so the interceptor can call it directly:

```typescript
function hydrateMarkersIn(root: ParentNode = document.body): void {
  const markers = root.querySelectorAll<HTMLElement>('[data-brust-island]:not([data-brust-hydrated])')
  for (const el of markers) {
    el.setAttribute('data-brust-hydrated', '1')  // idempotence guard
    // ... existing per-marker logic: read data-brust-* attrs, register trigger, dynamic import, hydrateRoot
  }
}

hydrateMarkersIn(document.body)  // initial-load entry — same behaviour as today
```

**`swapMainContent` helper** — sets the new HTML on the `<main>` element. The trust boundary is documented at the top of this spec: the HTML comes from the same Brust server that produced the initial page load, parsed and mounted through the standard browser HTML parser exactly as the initial response was. No untrusted user input enters this code path.

```typescript
function swapMainContent(main: HTMLElement, html: string): void {
  // Parse the trusted server response via DOMParser (inert parse — scripts
  // in the fragment are not executed during parsing) then importNode the
  // children into the live document and replace <main>'s children.
  // Same trust assumption as the initial server-rendered response — XSS in
  // server-rendered React would propagate either way.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  main.replaceChildren(
    ...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true))
  )
}
```

**Interceptor** — appended to the same file:

```typescript
function isInternalLink(a: HTMLAnchorElement, event: MouseEvent): boolean {
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
    swapMainContent(main, html)
    if (title) document.title = title
    if (push) history.pushState({}, '', url.href)
    window.scrollTo(0, 0)
    hydrateMarkersIn(main)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    console.warn('[brust] SPA navigation failed, falling back to full reload:', err)
    location.href = url.href
  } finally {
    if (inFlight === ac) inFlight = null
  }
}

document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a')
  if (!a || !isInternalLink(a, e)) return
  e.preventDefault()
  void navigate(new URL(a.href, location.href), /* push */ true)
})

window.addEventListener('popstate', () => {
  void navigate(new URL(location.href), /* push */ false)
})
```

**Link-handling matrix:**

| Click target | Outcome |
|---|---|
| Internal same-origin `<a href="/x">` (left click, no modifiers) | Intercept → JSON fetch → swap → pushState |
| External `<a href="https://other.com">` | Default browser navigation |
| `<a target="_blank">` or Cmd/Ctrl+click | Default (new tab / new window) |
| `<a href="#section">` (same-pathname anchor) | Default (browser-native scroll) |
| `<a data-brust-no-intercept href="/x">` | Default (full reload — explicit opt-out) |
| `<a href="/_brust/page/...">` or any `/_brust/*` | Default (framework internal — never intercept) |
| Back / forward button | `popstate` → JSON fetch → swap (no pushState) |
| Rapid clicks (3 in 50 ms) | Last click wins; previous fetches abort cleanly |

**Why `data-brust-hydrated` idempotence guard:** without it, calling `hydrateMarkersIn(document.body)` twice (e.g., bootstrap fires on initial load, then user navigates to a page whose new `<main>` doesn't reset existing markers outside `<main>`) would double-hydrate. The guard is a single DOM attribute write, cheap, and self-contained.

## 8. Error matrix

| Failure point | Detection | Client outcome | Server log |
|---|---|---|---|
| `fetch` network error (offline, DNS, refused) | rejected Promise in `navigate` | `location.href = url` full reload | (none — server unreachable) |
| Server returns 404 | `resp.ok === false` | Full reload (browser sees the same 404 OR re-resolves) | `info!` (existing route-match log) |
| Server returns 500 | `resp.ok === false` | Full reload | `error!` log from `navigationBranch` |
| JSON parse error | `resp.json()` rejects | Full reload | (none — body was malformed server-side) |
| `<main>` missing on current page | `document.querySelector('main')` is null | Full reload | (none) |
| Concurrent navigations | `inFlight.abort()` cancels previous | Aborted fetches return `name === 'AbortError'`, silently early-return | (none — abort is normal) |
| `pushState` throws (rare — long URL, security) | try/catch in interceptor (defensive) | Full reload | `console.warn` |
| Render throws server-side | try/catch in `navigationBranch` | 500 JSON response → client fallback | `error!` log |
| `renderToString` produces no `<main>` element | regex no-match | `html` = full HTML, client's `<main>` missing fallback fires | (none — degraded but recoverable) |

**Wire-level safety:** every error path either returns a parseable JSON envelope OR triggers the client's "full reload" fallback. The user never sees a stuck-loading UI; the worst case is a slower navigation that still succeeds.

## 9. Testing

**4 new runtime unit tests** (`runtime/islands/bootstrap.test.ts` — new file):

1. `isInternalLink` accepts plain same-origin `<a href>` (left click, no modifiers, no target, no opt-out attribute)
2. `isInternalLink` rejects each of: external origin, `target="_blank"`, modifier-click, `#anchor` to same path, `/_brust/` prefix, `data-brust-no-intercept` attribute, `<a download>`
3. `hydrateMarkersIn(root)` only scans within the given root subtree — markers outside the root are not hydrated
4. `hydrateMarkersIn` is idempotent — calling twice on the same root doesn't double-hydrate (verified via `data-brust-hydrated` attribute on each marker)

**3 new integration tests** (`tests/integration.test.ts`, ports 38240-38242):

1. **JSON shape** — `GET /_brust/page/blog/welcome` → 200, `application/json; charset=utf-8`, body parses to `{ html, title }`, `html` does NOT contain `<header>` or `<footer>` (Layout chrome excluded), `html` DOES contain `Post: welcome` (the page-specific h1), `title` ends with `Brust demo`
2. **404 navigation** — `GET /_brust/page/nonexistent` → 404 + `application/json` + body `{"error":"not found"}`
3. **`<main>`-missing fallback** — `GET /_brust/page/crash` → 200 + body's `html` field equals the full rendered HTML (no `<main>` in CrashBoundary output → regex falls back). Test asserts `html` contains the boundary's "CrashBoundary" text AND is non-empty even though there's no `<main>`.

**No new Rust unit tests** beyond the in-place test for `rewrite_envelope_kind` in `src/server.rs::tests`:

5. **(Rust)** `rewrite_envelope_kind_swap_renders_to_navigation` — `{"kind":"render","path":"/x"}` → `{"kind":"navigation","path":"/x"}`, only first occurrence replaced

**Example app changes:** none. Demo's Layout already has `<main>` and nav links — SPA navigation works automatically once the new bootstrap ships.

**Baseline preservation:** all 90 Rust + 98 runtime + 66 integration tests must pass UNCHANGED. The interceptor only adds NEW behaviour for clicks; existing tests don't trigger client clicks (they use `fetch`), so they're unaffected.

## 10. Limits & deferred

**Current limits (MVP):**
- Only swaps the `<main>` element. Pages without `<main>` fall back to full reload (not silently broken — the client interceptor handles this gracefully).
- No prefetch on hover, no view transitions, no scroll restoration on back/forward (always scrolls to top).
- No loading indicator during fetch (typical navigation is sub-100 ms; an indicator would flash distractingly).
- Cache layer untouched — navigation responses are not cached server-side. Browsers will respect any `Cache-Control` headers the response carries (none today).

**Deferred (out of scope):**
- Prefetch on `mouseenter` for likely-clicked links
- View Transitions API integration (`document.startViewTransition`)
- Scroll restoration on back/forward (preserve scroll per history entry)
- Optimistic UI / skeleton states during slow renders
- Per-route opt-out (a route flag that forces full reload — none of today's routes need it)
- `<Link>` component wrapper (typed `to:` prop, automatic `data-active` class) — `<a href>` is sufficient for now
- Form submissions (POST navigations) — only GETs are intercepted today
