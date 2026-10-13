// `@brust/core/client` (M3-F E6): Eden Treaty pre-wired to the brust actions mount. Browser-safe:
// elysia is type-only here. Differences from 0.1.x runtime/treaty.ts: docs/actions.md "The client".
import { type Treaty, treaty } from '@elysia/eden/treaty2'
import type { AnyElysia } from 'elysia'
import { type ActionCredentials, DEFAULT_ACTION_PREFIX } from './prefix'

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

interface PageGlobals {
  __BRUST_ACTION_PREFIX__?: string
  /** L16 R16.1: injected from `[actions] base_url` / BRUST_ACTIONS_BASE_URL / run({ config: { actionsBaseUrl } }). */
  __BRUST_ACTION_BASE__?: string
  /** L16 R16.2: injected from `[actions] credentials`. */
  __BRUST_ACTION_CREDENTIALS__?: ActionCredentials
}
const page = () => globalThis as PageGlobals

/** 0.1.x runtime/treaty.ts:86-93, verbatim order. A per-call `baseUrl` keeps the default prefix; a base that comes
 * from the page global (L16) pairs with the page's injected prefix, both being the same deployment's config. */
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
  // R16.1 order: opts.baseUrl, the page's __BRUST_ACTION_BASE__, relative.
  const b = opts?.baseUrl ?? page().__BRUST_ACTION_BASE__
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
  // R16.2: the page's credentials default (`opts.init` wins); only when it differs from the browser default.
  const creds = page().__BRUST_ACTION_CREDENTIALS__
  const defaults = creds !== undefined && creds !== 'same-origin' && typeof init !== 'function' ? { credentials: creds } : undefined
  // keepDomain: Eden would rewrite a relative base to `https:///…` (probe kd.ts).
  // The root prefix (an actions-only deployment) adds nothing to the base: `https://api.example.com/team`, not `//team`.
  const base = resolveBaseUrl(opts)
  const prefix = resolvePrefix(opts)
  return treaty<App, Head>(base !== '' && prefix === '/' ? base : base + prefix, {
    ...rest,
    keepDomain: true,
    ...(fetcher ? { fetcher } : {}),
    ...(init || defaults ? { fetch: typeof init === 'function' ? init : { ...defaults, ...init } } : {}),
  })
}
