# B3 / S6 — request context + cookie read/write primitive

> Status: design · 2026-06-03 · branch `feat/s6-request-context-cookies`
> Gap: FRAMEWORK-GAPS S6 (◆ CONFIRMED — team store module-global, no session/cookie helper).
> Scope locked (user): **request-context primitive + cookie-write** (NOT full session abstraction).

## Goal

Framework primitives so apps stop relying on module-global state per visitor:
1. **`getRequestContext()`** — a per-request key-value bag (ALS-backed, like `runInStoreContext`)
   readable from loaders, actions, middleware, render — for passing request-scoped data (a session
   id, a derived user, a theme) without threading args or using module globals.
2. **`cookies` helper** — read (`req.cookies` already parsed) + **write**: `cookies.set(name, value,
   opts)` / `cookies.delete(name)` stage `Set-Cookie` into a request-scoped bag that the framework
   flushes onto the HTTP response (action + React render paths).

Unblocks B4 (dark-mode): a `/theme` action `cookies.set('mode','dark')`; the native page loader reads
`req.cookies.mode` → `<BrustPage data-mode={mode}>` (both already possible; cookie-write helper makes
the action ergonomic + correct `Set-Cookie` serialization).

## Non-goals (ดังๆ — out of scope)

- **Full session abstraction** (`defineSession`, cookie-backed id + server store, signing) — deferred.
  S6 "team store global" is NOT fully fixed; this ships the PRIMITIVES apps build sessions on.
- **Cookie-write from a NATIVE LOADER → native HTML response.** Native render goes through the Rust
  fast-lane (`napiRenderJinja(workerId, dataLen, templateName, status?)` — no headers param).
  Adding a `headers` param is a Rust change, deferred. **Pattern: write cookies from an ACTION**
  (where `respond`/the flush works), native pages READ `req.cookies`. Documented limitation.
- Cookie signing / encryption / `__Host-` enforcement — apps choose; helper passes opts through.

## Architecture

### 1. `runtime/request-context.ts` (new) — ALS request scope
Mirrors `store/server-context.ts` (incl. its **client-bundle warning**: imports `node:async_hooks`
→ MUST NOT be reachable from `brustjs/client` or `brustjs/store`; export `cookies`/`getRequestContext`
ONLY from the server `runtime/index.ts`). ONE ALS holding a per-request scope object with **distinctly
named** fields (don't conflate read vs write):
```ts
interface RequestScope { ctx: Map<string, unknown>; reqCookies: Record<string,string>; setCookies: string[] }
const reqCtx = new AsyncLocalStorage<RequestScope>()
export function runInRequestScope<T>(reqCookies: Record<string,string>, fn: () => T): T {
  return reqCtx.run({ ctx: new Map(), reqCookies, setCookies: [] }, fn)
}
export function getRequestContext(): Map<string, unknown> { /* scope.ctx; THROWS if outside (like store) */ }
export function __scope(): RequestScope | undefined  // internal — getStore(); used by cookies + flush
```
Compose with `runInStoreContext` — `runInRequestScope(req.cookies, () => runInStoreContext(fn))` OUTER at
the action dispatch path + loader/render + **SPA navigation** sites (B1's loader-cache wrap is a SEPARATE
branch — do NOT assume present; wrap independently here).

### 2. `runtime/cookies.ts` (new) — cookie helper
```ts
export interface CookieOptions { maxAge?, expires?, path?, domain?, secure?, httpOnly?, sameSite? }
export const cookies = {
  get(name: string): string | undefined        // from current request scope's req — see note
  set(name: string, value: string, opts?: CookieOptions): void  // serialize + __stageSetCookie
  delete(name: string, opts?: Pick<CookieOptions,'path'|'domain'>): void  // set with Max-Age=0
}
function serializeCookie(name, value, opts): string  // RFC 6265 Set-Cookie line (encode value; Max-Age/Path/...)
```
`cookies.get` reads `scope.reqCookies` (seeded from `req.cookies` at wrap setup). Note: in actions/loaders
that already hold `ctx.req`, `req.cookies[name]` is directly available — `cookies.get` is a convenience for
code without `req` in hand.

### 3. Flush staged Set-Cookie → response (TS paths only)
**Canonical key:** the Rust writer stores headers in a **case-sensitive `BTreeMap`**
(`crates/brust/src/render_stream.rs`) — it does NOT lower-case-dedup (that skip is a different non-worker
path in `http.rs`). So `'Set-Cookie'` and `'set-cookie'` would emit as TWO lines. **All cookie writes use
the single canonical key `'set-cookie'` (lowercase) everywhere** to keep the one-cookie invariant.
- **Action dispatch** (`routes.ts` `dispatchAction`): after the handler/chain, read `scope.setCookies`.
  **Precedence (defined):** if the handler ALSO set `response.headers['set-cookie']` via `respond(_,
  {headers})`, the **explicit `respond` value WINS** (do not clobber) + emit a dev-warn on conflict.
  Otherwise set `response.headers['set-cookie'] = scope.setCookies[last]`. If `scope.setCookies.length > 1`,
  emit a dev-warn (only the last is sent — multiple Set-Cookie per response is the documented limitation).
- **React render path**: same flush where the render response headers are forwarded (React supports headers).
- **SPA navigation** (`navigationBranch` ~`:1055`/`:1086`): runs the SAME loader/middleware chain → MUST be
  wrapped in `runInRequestScope` AND flush `scope.setCookies` into the nav response headers (else a
  `cookies.set` during client-side nav is silently dropped). Wrap + flush this site too.
- **Native render**: staged cookies NOT flushed (no headers param on `napiRenderJinja`) → `cookies.set` in a
  native loader emits a **dev warn (no-op)**; documented. (`req.cookies` READ still works in native loaders.)
- **MCP / SSE paths**: no `runInRequestScope` wrap → `getRequestContext` throws / `cookies.set` warns there.
  Documented as out-of-scope this round (cookie-write from MCP/SSE deferred).

### 4. Exports — `runtime/index.ts`
`export { getRequestContext } from './request-context.ts'` + `export { cookies } from './cookies.ts'`
(+ type `CookieOptions`). `runInRequestScope`/`__*` NOT exported (internal).

## Tests
### `runtime/cookies.test.ts`
- `serializeCookie`: name=value; Max-Age/Path/Domain/Secure/HttpOnly/SameSite emitted; value URL-encoded; `delete` → `Max-Age=0`.
- `cookies.set` inside `runInRequestScope` → staged; `__stagedSetCookies()` returns them; outside scope → no-op + (dev) warn, no throw.
- `cookies.get` returns seeded req cookie; missing → undefined.
### `runtime/request-context.test.ts`
- `getRequestContext()` returns a per-scope Map; isolated across two scopes; throws outside scope.
- nested with store context works (both ALS active).
### `runtime/action-dispatch.test.ts` (extend)
- action calling `cookies.set('a','1')` → response `headers['set-cookie']` (or array) contains the serialized cookie.
- multiple `cookies.set` → multiple Set-Cookie lines.

## Acceptance criteria
1. `cd runtime && bun test` (cookies + request-context + action-dispatch) green; no regression vs baseline.
2. `bun run ci` (biome) clean.
3. exports resolve: `import { getRequestContext, cookies } from 'brustjs'`.
4. action `cookies.set` → `Set-Cookie` on the HTTP response (dispatch test proves the header).
5. native loader reading `req.cookies` unaffected; `cookies.set` in a native loader is a documented no-op (warn).

## Known limitations (documented)
- cookie-write reaches the response only via action + React paths; native-render cookie-write deferred (napi headers param — future). Write cookies from an action.
- no session abstraction; no signing (opts passthrough only).
- request-context is per-request in-memory (not persisted).

## Open questions → resolved (Task 0 grounded)
- **Set-Cookie multiple headers?** ✅ grounded: `RouteResponse.headers` is `Record<string,string>` and the
  Rust writer **dedupes by lower-cased key → strictly ONE value per header name** (`routes.ts:139-141`).
  A `setCookies: string[]` field would need a Rust writer change (scope creep). **Resolution: B3
  supports ONE `Set-Cookie` per response** via `headers['set-cookie'] = serialize(...)` (TS-only;
  covers B4's theme cookie + the overwhelming common case). `cookies.set` stages a list; the flush
  emits the LAST staged cookie and, if MORE than one was staged, emits a **dev warning** (not silent).
  **Multiple Set-Cookie per response = documented limitation** (needs a Rust `setCookies[]` field — deferred).
- **ALS wrap sites** — B1 wrapped loader/render only; S6 ALSO needs the **action dispatch** path wrapped
  (so `cookies.set`/`getRequestContext` work in handlers + the flush can read the staged bag). Wrap
  `runInRequestScope(call.req, () => …)` around the action terminal/chain in `dispatchAction`, and around
  the loader/render sites. (This branch is off main; B1's loader-cache wrap is on a separate branch — do
  NOT assume it's present; wrap independently.)
