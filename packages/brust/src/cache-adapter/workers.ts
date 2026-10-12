// The cache adapter inside a Workers isolate (cache adapters R11, R14): `install(rt, ext)` builds the
// adapter, wires `cache.invalidate`'s publish through `waitUntil`, and answers the wasm side's bridge
// (`crates/brust-wasm/src/host.rs` `CacheBridge`). No `bun` import (it is bundled into brust-app.js).
import { checkRuntime, compose, instantiate } from './load'
import { setCacheRuntime } from './runtime'
import type { CacheAdapter, SetMeta } from './types'

/** What the wasm side passes to `install` (`bridge.rs`). */
export interface CfRuntimeBase {
  l2Count?(name: string): boolean
}

/** `CONFIG.cache` (build/cf-entry.ts), as the entry passes it. */
export interface CfCacheConfig {
  adapter: string
  getTimeoutMs: number
  maxBodyBytes: number
  namespace: string
  buildId: string
  epochIntervalMs: number
}

/** The generated entry's second `install` argument. */
export interface CfInstallExt {
  /** The adapter module's namespace, default export, or factory. */
  adapter: unknown
  options: Record<string, unknown>
  /** A composed built-in broadcast (`[cache] broadcast`), same forms as `adapter`. */
  broadcast?: unknown
  broadcastOptions?: Record<string, unknown>
  config: CfCacheConfig
  waitUntil: (p: Promise<unknown>) => void
}

/** The wasm side's view: `get`/`set` only with a store, `since` only with a pull broadcast. */
export interface CfCacheBridge {
  origin: string
  get?: (key: string) => Promise<{ json: string; body: Uint8Array | null }>
  set?: (key: string, json: string, body: Uint8Array) => void
  since?: (seq: number) => Promise<string>
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Throws (a TypeError → the Worker refuses to boot, lane-3 R11) on a bad adapter or a push-only broadcast. */
export function installCache(rt: CfRuntimeBase, ext: CfInstallExt): CfCacheBridge {
  const { config: c, waitUntil } = ext
  let a: CacheAdapter = instantiate(ext.adapter, ext.options, `"${c.adapter}"`)
  if (ext.broadcast !== undefined) {
    const other = instantiate(ext.broadcast, ext.broadcastOptions ?? {}, 'broadcast')
    if (!other.broadcast) throw new TypeError(`cache adapter "${other.name}" has no broadcast to compose`)
    a = compose(a, other)
  }
  checkRuntime(a, 'workers')
  const count = (name: string) => void rt.l2Count?.(name)
  // `init` may do I/O, which a Worker refuses at start: it runs on the first use, once.
  let ready: Promise<void> | null = null
  const ensure = () => (ready ??= Promise.resolve(a.init?.({ namespace: c.namespace, buildId: c.buildId, runtime: 'workers', workerId: 0 })))
  // A Worker may not draw random values at start (global scope): the origin is made on first read.
  let origin: string | null = null
  const getOrigin = () => (origin ??= crypto.randomUUID())
  setCacheRuntime({
    adapter: a,
    get origin() {
      return getOrigin()
    },
    defer: (p) => waitUntil(p),
    count,
    ready: ensure,
  })
  const store = a.store
  const since = a.broadcast?.since?.bind(a.broadcast)
  return {
    get origin() {
      return getOrigin()
    },
    ...(store
      ? {
          async get(key: string) {
            try {
              await ensure()
              const r = await store.get(key)
              if (!r.page || r.page.body.length > c.maxBodyBytes) {
                if (r.page) count('errors')
                return { json: JSON.stringify({ hit: false, stamp: r.stamp }), body: null }
              }
              const p = r.page
              return { json: JSON.stringify({ hit: true, status: p.status, headers: p.headers, stamp: r.stamp, entryStamp: r.entryStamp, storedAt: r.storedAt }), body: p.body }
            } catch (e) {
              return { json: JSON.stringify({ error: describe(e) }), body: null }
            }
          },
          set(key: string, json: string, body: Uint8Array) {
            const task = (async () => {
              const { status, headers, meta } = JSON.parse(json) as { status: number; headers: [string, string][]; meta: SetMeta }
              await ensure()
              count((await store.set(key, { status, headers, body }, meta)) ? 'sets' : 'set_refused')
            })().catch((e) => {
              count('errors')
              console.error(`[brust] cache adapter "${a.name}": set failed: ${describe(e)}`)
            })
            waitUntil(task)
          },
        }
      : {}),
    ...(since
      ? {
          async since(seq: number) {
            await ensure()
            return JSON.stringify(await since(seq))
          },
        }
      : {}),
  }
}
