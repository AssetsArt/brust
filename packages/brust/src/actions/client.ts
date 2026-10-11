// `@brust/core/client` (M3-F E6): Eden Treaty pre-wired to the brust actions mount. Browser-safe:
// elysia is type-only here. Differences from 0.1.x runtime/treaty.ts: docs/actions.md "The client".
import { type Treaty, treaty } from '@elysia/eden/treaty2'
import type { AnyElysia } from 'elysia'
import { DEFAULT_ACTION_PREFIX } from './prefix'

export { DEFAULT_ACTION_PREFIX }
export type { Treaty }

export interface ClientOptions<Head extends Record<string, unknown> = {}>
  extends Omit<Treaty.Config<Head>, 'keepDomain' | 'fetcher' | 'fetch'> {
  /** Mount point of the actions app. Default: see resolvePrefix. */
  prefix?: string
  /** Absolute http(s) origin of ANOTHER brust deployment; the page's injected prefix is then ignored. */
  baseUrl?: string
  /** The transport (0.1.x name; Eden calls it `fetcher`). */
  fetch?: typeof fetch
  /** RequestInit defaults for every call (Eden's `fetch` option), e.g. `{ credentials: 'include' }`. */
  init?: Treaty.Config<Head>['fetch']
}

/** 0.1.x runtime/treaty.ts:86-93, verbatim order. */
export function resolvePrefix(opts?: { prefix?: string; baseUrl?: string }): string {
  if (opts?.prefix) return opts.prefix
  if (opts?.baseUrl !== undefined) return DEFAULT_ACTION_PREFIX
  return (
    (globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__ ??
    DEFAULT_ACTION_PREFIX
  )
}

/** 0.1.x runtime/treaty.ts:95-106; message names `client`. */
export function resolveBaseUrl(opts?: { baseUrl?: string }): string {
  const b = opts?.baseUrl
  if (b === undefined) return ''
  if (!/^https?:\/\//.test(b))
    throw new Error(
      `client baseUrl must be an absolute http(s) origin (got ${JSON.stringify(b)})`,
    )
  return b.replace(/\/+$/, '')
}

export function client<const App extends AnyElysia, Head extends Record<string, unknown> = {}>(
  opts: ClientOptions<Head> = {},
): Treaty.Instance<App, Head> {
  const { prefix: _p, baseUrl: _b, fetch: fetcher, init, ...rest } = opts
  // keepDomain: Eden would rewrite a relative base to `https:///…` (probe kd.ts).
  return treaty<App, Head>(resolveBaseUrl(opts) + resolvePrefix(opts), {
    ...rest,
    keepDomain: true,
    ...(fetcher ? { fetcher } : {}),
    ...(init ? { fetch: init } : {}),
  })
}
