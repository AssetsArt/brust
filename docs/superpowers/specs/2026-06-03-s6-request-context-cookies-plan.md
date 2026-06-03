# Plan: B3/S6 — request-context + cookie read/write primitive

Spec: `2026-06-03-s6-request-context-cookies-design.md`. Branch `feat/s6-request-context-cookies`.
Baseline (parent `5aa114c`, off main): `cd runtime && bun test` = 378 pass / 0 fail. TS-only, no Rust,
no napi rebuild. Gates: `bun run ci` (biome) + `cd runtime && bun test`.

## T1 — `runtime/request-context.ts` + `runtime/cookies.ts` + unit tests (TDD)

### Step 1a RED: `runtime/request-context.test.ts` + `runtime/cookies.test.ts`
request-context: `getRequestContext()` returns a per-scope Map; isolated across two `runInRequestScope`;
THROWS outside scope; nested with `runInStoreContext` both active.
cookies: `serializeCookie` (name=value; Max-Age/Path/Domain/Secure/HttpOnly/SameSite; value URL-encoded;
delete→Max-Age=0); `cookies.set` inside scope → `scope.setCookies` has the serialized line; outside scope
→ dev-warn no-op (no throw); `cookies.get` returns seeded reqCookie, missing→undefined.

### Step 1b GREEN: `runtime/request-context.ts`
Per spec §1 — keep the `node:async_hooks` client-bundle warning comment (mirror server-context.ts:1-6).
```ts
import { AsyncLocalStorage } from 'node:async_hooks'
interface RequestScope { ctx: Map<string, unknown>; reqCookies: Record<string,string>; setCookies: string[] }
const reqCtx = new AsyncLocalStorage<RequestScope>()
export function runInRequestScope<T>(reqCookies: Record<string,string>, fn: () => T): T {
  return reqCtx.run({ ctx: new Map(), reqCookies, setCookies: [] }, fn)
}
export function getRequestContext(): Map<string, unknown> {
  const s = reqCtx.getStore(); if (!s) throw new Error('getRequestContext() called outside a request scope'); return s.ctx
}
export function __scope(): RequestScope | undefined { return reqCtx.getStore() }
```
### Step 1b GREEN: `runtime/cookies.ts`
```ts
import { __scope } from './request-context.ts'
export interface CookieOptions { maxAge?: number; expires?: Date; path?: string; domain?: string; secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict'|'Lax'|'None' }
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string { /* RFC6265 line, encodeURIComponent(value), append attrs */ }
export const cookies = {
  get(name: string): string | undefined { return __scope()?.reqCookies[name] },
  set(name: string, value: string, opts?: CookieOptions): void {
    const s = __scope(); if (!s) { /* dev warn */ return } s.setCookies.push(serializeCookie(name, value, opts))
  },
  delete(name: string, opts?: Pick<CookieOptions,'path'|'domain'>): void { this.set(name, '', { ...opts, maxAge: 0 }) },
}
```
Run `cd runtime && bun test request-context.test.ts cookies.test.ts` → green.

## T2 — wire scope + flush (`runtime/routes.ts`) + exports

### wire
- `import { runInRequestScope, __scope } from './request-context.ts'`.
- Wrap with `runInRequestScope(call.req.cookies ?? {}, () => <existing runInStoreContext(...)>)` at:
  (a) `dispatchAction` action terminal/chain (so handlers can cookies.set/getRequestContext),
  (b) native render loader site, (c) React render loader/render site, (d) `navigationBranch` site.
  VERIFY each site's `req`/`call.req` is in scope (grep `runInStoreContext` + the dispatchAction handler run).
### flush helper
```ts
function flushSetCookie(headers: Record<string,string> | undefined): Record<string,string> | undefined {
  const staged = __scope()?.setCookies ?? []
  if (staged.length === 0) return headers
  if (staged.length > 1) { /* dev warn: only last sent */ }
  const h = { ...(headers ?? {}) }
  if (h['set-cookie'] !== undefined) { /* dev warn conflict — respond() wins, keep h */ return h }
  h['set-cookie'] = staged[staged.length - 1]!
  return h
}
```
- `dispatchAction`: at the final return, `headers: flushSetCookie(response.headers)`.
- React render + nav: apply `flushSetCookie` where response headers are built (NOT native — no headers param).
### exports `runtime/index.ts`
`export { getRequestContext } from './request-context.ts'`; `export { cookies } from './cookies.ts'`;
`export type { CookieOptions } from './cookies.ts'`. (NOT runInRequestScope/__scope.)
Run `cd runtime && bun test routes.test.ts action-dispatch.test.ts`.

## T3 — action-dispatch test (extend `runtime/action-dispatch.test.ts`)
- handler `cookies.set('mode','dark',{path:'/'})` → `res.headers['set-cookie']` contains `mode=dark; Path=/`.
- handler `respond(body,{headers:{'set-cookie':'x=1'}})` + `cookies.set('mode','dark')` → explicit respond wins (`x=1`), dev-warn (don't assert warn text, just the precedence).
- handler not in any cookies.set → no set-cookie header.

## T4 — dogfood (light, defer real dark-mode to B4)
B4 owns the dark-mode feature. For B3, OPTIONALLY add a tiny example usage in pokedex actions (e.g. a
`/theme` action that `cookies.set('mode', body.mode)`) IF it doesn't bloat — else skip dogfood (B4 will
exercise it). Keep B3 framework-only; note B4 will dogfood.

## Gates / acceptance
1. `cd runtime && bun test` → 378 + new, 0 fail.
2. `bun run ci` (biome) clean.
3. exports resolve.
4. action `cookies.set` → `set-cookie` header (T3 proves).
5. `getRequestContext` throws outside scope; works inside.

## BLOCKED fallback
- If wrapping `dispatchAction` in `runInRequestScope` breaks middleware/respond flow, wrap only the
  terminal+flush and confirm `respond` headers still forward.
- If a wrap site's `req.cookies` is undefined (some envelope), default `{}`.
- multiple Set-Cookie: documented limitation (last wins + warn) — do NOT attempt a Rust setCookies[] field this round.

## Final verification (Phase 6)
1. `cd runtime && bun test` no regression + new.
2. `bun run ci` clean.
3. Read the flush + wrap-site diff myself; confirm canonical `'set-cookie'` key + respond-precedence + nav wrapped.
