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
Mirrors `store/server-context.ts`. ONE ALS holding a per-request object `{ ctx: Map<string,unknown>;
cookies: SetCookie[] }`.
```ts
const reqCtx = new AsyncLocalStorage<RequestScope>()
export function runInRequestScope<T>(fn: () => T): T { return reqCtx.run({ ctx: new Map(), setCookies: [] }, fn) }
export function getRequestContext(): Map<string, unknown> { /* current scope's ctx; throws if outside */ }
export function __stagedSetCookies(): SetCookie[]  // internal — read by the flush
export function __stageSetCookie(c: SetCookie): void // internal — called by cookies.set
```
Compose with the existing `runInStoreContext` wrap at the loader/render/action sites (a combined
`runInRequestScope(() => runInStoreContext(fn))` — like B1's pattern, but B1 is a separate branch;
here add `runInRequestScope` OUTER at the same routes.ts sites + the action dispatch terminal).

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
`cookies.get` reads the request's parsed cookies — needs access to `req` in scope; stash `req.cookies`
into the request scope at `runInRequestScope` setup (the wrap site has `call.req`). So
`runInRequestScope(req, fn)` seeds `{ cookies: req.cookies, ctx, setCookies: [] }`.

### 3. Flush staged Set-Cookie → response (TS paths only)
- **Action dispatch** (`routes.ts` `dispatchAction`): after the handler/chain, read `__stagedSetCookies()`
  and merge into the response `headers` (append each as a `Set-Cookie`; RouteResponse.headers →
  BranchResponse → Rust writes). Works alongside `respond(_, {headers})`.
- **React render path**: merge staged cookies into the render response headers where status/headers are
  forwarded (the React path supports headers; native does not — see non-goal).
- **Native render**: staged cookies are NOT flushed (no headers param) → if `cookies.set` is called in a
  native loader, **warn once** (dev) that it's a no-op; documented.

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
