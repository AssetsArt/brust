// Resolving and validating the configured adapter (cache-adapter R1, R8, R14). The build checks
// that a built-in package is installed; this runs where the adapter lives (each Bun worker, or the
// Workers isolate's `install`). No `bun` import: resolution is the caller's (`resolve`).
import type { CacheAdapter, CacheAdapterFactory } from './types'

/** What `brust build` writes to `manifest.cache` / `CONFIG.cache`. */
export interface CacheManifest {
  adapter: string
  /** `custom`: the bundled module, relative to dist (native) — Workers import it in the entry. */
  module?: string
  /** A built-in broadcast composed onto the adapter (`broadcast = "cloudflare-do"`). */
  broadcast?: string
  options: Record<string, unknown>
  /** Options of the composed broadcast's factory. */
  broadcastOptions?: Record<string, unknown>
  namespace: string
  getTimeoutMs: number
  maxBodyBytes: number
  epochIntervalMs: number
  buildId: string
}

/** The built-in adapters: each package subpath's default export is a factory (the lanes B/C contract). */
export const BUILTINS: Readonly<Record<string, string>> = {
  redis: '@brust/cache-redis',
  dragonfly: '@brust/cache-redis/dragonfly',
  'cloudflare-kv': '@brust/cache-cloudflare/kv',
  'cloudflare-do': '@brust/cache-cloudflare/do',
}

export const ADAPTER_NAMES = ['redis', 'dragonfly', 'cloudflare-kv', 'cloudflare-do', 'custom'] as const

/** A built-in name's install hint (the build's error). */
export function installHint(name: string): string {
  const spec = BUILTINS[name] ?? name
  const pkg = spec.split('/').slice(0, 2).join('/')
  return `adapter "${name}" needs ${pkg} (bun add ${pkg})`
}

/** `env:NAME` strings of a built-in's option table → `env[NAME]` (missing → a boot error naming NAME only). */
export function resolveEnvOptions(o: Record<string, unknown>, env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v.startsWith('env:')) {
      const name = v.slice(4)
      const val = env[name]
      if (val === undefined || val === '') throw new Error(`cache adapter option ${k}: environment variable ${name} is not set`)
      out[k] = val
    } else out[k] = v
  }
  return out
}

/** A module's default export → the adapter (a factory is called with `options`). */
export function instantiate(mod: unknown, options: Record<string, unknown>, what: string): CacheAdapter {
  const d = (mod as { default?: unknown } | null)?.default ?? mod
  const a = typeof d === 'function' ? (d as CacheAdapterFactory)(options) : d
  return validateAdapter(a, what)
}

const fn = (o: unknown, k: string) => typeof (o as Record<string, unknown> | undefined)?.[k] === 'function'

/** The shape check (TypeError naming what is wrong). */
export function validateAdapter(a: unknown, what: string): CacheAdapter {
  const bad = (m: string): never => {
    throw new TypeError(`cache adapter ${what}: ${m}`)
  }
  if (!a || typeof a !== 'object') bad('the default export is not an adapter or a factory returning one')
  const x = a as CacheAdapter
  if (typeof x.name !== 'string' || !x.name) bad('no name')
  if (!Array.isArray(x.runtimes) || x.runtimes.some(r => r !== 'bun' && r !== 'workers')) bad('runtimes must list "bun" and/or "workers"')
  if (x.store && !(fn(x.store, 'get') && fn(x.store, 'set') && fn(x.store, 'invalidate') && typeof x.store.maxBodyBytes === 'number'))
    bad('store needs get, set, invalidate and maxBodyBytes')
  if (x.broadcast) {
    if (!fn(x.broadcast, 'publish')) bad('broadcast needs publish')
    const push = fn(x.broadcast, 'subscribe')
    const pull = fn(x.broadcast, 'since')
    if (push === pull) bad('broadcast needs exactly one of subscribe (push) or since (pull)')
  }
  if (!x.store && !x.broadcast) bad('neither a store nor a broadcast')
  return x
}

/** R1 (native) / R14 (Workers): the runtime and the broadcast mode must fit where it runs. */
export function checkRuntime(a: CacheAdapter, runtime: 'bun' | 'workers'): void {
  if (!a.runtimes.includes(runtime))
    throw new TypeError(`cache adapter "${a.name}" does not run on ${runtime === 'bun' ? 'Bun' : 'Cloudflare Workers'} (runtimes: ${a.runtimes.join(', ')})`)
  if (!a.broadcast) return
  const push = typeof a.broadcast.subscribe === 'function'
  if (runtime === 'bun' && !push) throw new TypeError(`cache adapter "${a.name}": native needs a push broadcast (subscribe); pull (since) is Workers-only in v1`)
  if (runtime === 'workers' && push) throw new TypeError(`cache adapter "${a.name}": push-only broadcast (subscribe) cannot run on Workers; it needs since (pull)`)
}

/**
 * The configured adapter. `load(spec, builtin)` imports a module (the caller resolves it: a custom
 * `module` relative to dist natively, a built-in package from the app root). `env` resolves
 * built-in `env:` options.
 */
export async function loadAdapter(
  m: CacheManifest,
  runtime: 'bun' | 'workers',
  load: (spec: string, builtin: boolean) => Promise<unknown>,
  env: Record<string, string | undefined>,
): Promise<CacheAdapter> {
  let adapter: CacheAdapter
  if (m.adapter === 'custom') {
    if (!m.module) throw new Error('cache: adapter "custom" without a module')
    adapter = instantiate(await load(m.module, false), m.options, `"custom" (${m.module})`)
  } else {
    const spec = BUILTINS[m.adapter]
    if (!spec) throw new Error(`cache: unknown adapter "${m.adapter}"`)
    adapter = instantiate(await load(spec, true), resolveEnvOptions(m.options, env), `"${m.adapter}"`)
  }
  if (m.broadcast) {
    const spec = BUILTINS[m.broadcast]
    if (!spec) throw new Error(`cache: unknown broadcast "${m.broadcast}"`)
    const other = instantiate(await load(spec, true), resolveEnvOptions(m.broadcastOptions ?? {}, env), `"${m.broadcast}" (broadcast)`)
    if (!other.broadcast) throw new TypeError(`cache adapter "${m.broadcast}" has no broadcast to compose`)
    adapter = compose(adapter, other)
  }
  checkRuntime(adapter, runtime)
  return adapter
}

/** `base`'s store with `other`'s broadcast; both are initialised and closed. Built explicitly (not a
 * spread) so a class-based adapter keeps its prototype methods. */
export function compose(base: CacheAdapter, other: CacheAdapter): CacheAdapter {
  // A broadcast that knows its store partner (the Cloudflare DO + KV floors) composes itself.
  const own = (other as { composeWith?: (store: CacheAdapter) => CacheAdapter }).composeWith
  if (typeof own === 'function') return own.call(other, base)
  return {
    name: base.name,
    runtimes: base.runtimes.filter(r => other.runtimes.includes(r)),
    ...(base.store ? { store: base.store } : {}),
    broadcast: other.broadcast,
    async init(ctx) {
      await base.init?.(ctx)
      await other.init?.(ctx)
    },
    async close() {
      await Promise.allSettled([base.close?.(), other.close?.()])
    },
  }
}
