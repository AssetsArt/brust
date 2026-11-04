// The in-memory cache adapter: the reference implementation of the contract (exact stale-write
// guard, push or pull broadcast with a bounded ring) and the test double for brust's own suites.
// Not a production backend: it shares nothing across processes. No `bun` import (CF-bundle safe).
import type {
  CacheAdapter,
  CacheBroadcast,
  CacheStore,
  EpochSince,
  GetResult,
  InvalidateArgs,
  InvalidationEvent,
  SetMeta,
  StoredPage,
} from './types'

export interface MemoryAdapterOptions {
  broadcast?: 'push' | 'pull' | 'none'
  /** Ring capacity in events (pull). Default 1024. */
  ring?: number
  /** Ring capacity in serialized bytes (pull). Default 1 MiB. */
  ringBytes?: number
  /** Default 8 MiB. */
  maxBodyBytes?: number
  now?: () => number
}

/** One event above this many serialized bytes is kept as a gap marker (readers clear). */
const OVERSIZE_EVENT = 64 * 1024

interface Entry {
  page: StoredPage
  tags: string[]
  method: string
  path: string
  /** The route-cache key prefix (F493); `''` = none. */
  prefix: string
  entryStamp: number | null
  storedAt: number
  expiresAt: number
}

type Slot = { seq: number; bytes: number; event: InvalidationEvent | null }

export interface MemoryAdapterTest {
  /** A new generation (a restarted broadcast): readers see `gen` change. */
  regen(): void
  /** The next `get` settles as a miss after `ms` (default 2000). */
  hangNextGet(ms?: number): void
  /** The next store/broadcast call rejects. */
  failNext(): void
  /** The next `store.invalidate` waits `ms` before it marks and deletes (a slow networked store). */
  delayNextInvalidate(ms: number): void
  publishCount(): number
  /** Stored entries (expired ones included). */
  size(): number
}

export type MemoryAdapter = CacheAdapter & { store: CacheStore; __test: MemoryAdapterTest }

const pathName = (method: string | undefined, path: string) => `${method ?? 'GET'} ${path}`

// Marker names (F493: scoped by prefix, so one prefix's invalidation refuses only that prefix's stale
// writes). A prefix is JSON-quoted: self-delimiting, so names of different prefixes never meet.
const tagName = (t: string) => `t:${t}`
const pName = (m: string | undefined, p: string) => `p:${pathName(m, p)}`
const px = (prefix: string) => `px:${JSON.stringify(prefix)}`
const ptName = (prefix: string, t: string) => `pt:${JSON.stringify(prefix)}${t}`
const ppName = (prefix: string, m: string | undefined, p: string) => `pp:${JSON.stringify(prefix)}${pathName(m, p)}`

/** The marker names an invalidation raises. `{ prefix }` alone ignores `method` (conservative). */
function invalidationNames(a: InvalidateArgs): string[] {
  const tags = a.tags ?? []
  const pre = a.prefix
  if (pre === undefined) return [...tags.map(tagName), ...(a.path !== undefined ? [pName(a.method, a.path)] : [])]
  if (!tags.length && a.path === undefined) return [px(pre)]
  return [...tags.map(t => ptName(pre, t)), ...(a.path !== undefined ? [ppName(pre, a.method, a.path)] : [])]
}

/** Every marker name that covers an entry. */
function entryNames(e: { tags: string[]; method: string; path: string; prefix: string }): string[] {
  return [
    ...e.tags.map(tagName),
    pName(e.method, e.path),
    px(e.prefix),
    ...e.tags.map(t => ptName(e.prefix, t)),
    ppName(e.prefix, e.method, e.path),
  ]
}

/** Does `a` delete `e`? (`key` alone deletes nothing: the store holds pages only.) */
function covers(a: InvalidateArgs, e: Entry): boolean {
  if (a.prefix !== undefined && e.prefix !== a.prefix) return false
  const tags = a.tags ?? []
  if (!tags.length && a.path === undefined) return a.prefix !== undefined && (a.method === undefined || a.method === e.method)
  return e.tags.some(t => tags.includes(t)) || (a.path !== undefined && pathName(e.method, e.path) === pathName(a.method, a.path))
}

export function memoryAdapter(o: MemoryAdapterOptions = {}): MemoryAdapter {
  const mode = o.broadcast ?? 'push'
  const ringCap = o.ring ?? 1024
  const ringBytes = o.ringBytes ?? 1_048_576
  const maxBodyBytes = o.maxBodyBytes ?? 8_388_608
  const now = o.now ?? Date.now
  const entries = new Map<string, Entry>()
  const nameSeq = new Map<string, number>()
  let seq = 0
  // Drawn on first use: a Workers module may not make random values at global scope.
  let genValue: string | null = null
  const gen = () => (genValue ??= randomGen())
  const ring: Slot[] = []
  let ringUsed = 0
  /** The highest seq no longer in the ring (a reader at or below seq-1 of it is behind). */
  let dropped = 0
  let publishes = 0
  let hang: number | null = null
  let fail = false
  let invalidateDelay = 0
  const subscribers = new Set<{ on: (e: InvalidationEvent) => void; onGap: () => void }>()

  const guarded = mode !== 'none'
  const failing = () => {
    if (!fail) return false
    fail = false
    return true
  }
  const mark = (args: InvalidateArgs, s: number) => {
    for (const n of invalidationNames(args)) nameSeq.set(n, Math.max(nameSeq.get(n) ?? 0, s))
  }

  const store: CacheStore = {
    maxBodyBytes,
    async get(key: string): Promise<GetResult> {
      if (failing()) throw new Error('memory adapter: injected failure')
      if (hang !== null) {
        const ms = hang
        hang = null
        await new Promise(r => setTimeout(r, ms))
        return { page: null, stamp: guarded ? seq : null, entryStamp: null, storedAt: null }
      }
      const e = entries.get(key)
      const stamp = guarded ? seq : null
      if (!e || e.expiresAt <= now()) {
        if (e) entries.delete(key)
        return { page: null, stamp, entryStamp: null, storedAt: null }
      }
      return { page: copyPage(e.page), stamp, entryStamp: e.entryStamp, storedAt: e.storedAt }
    },
    async set(key: string, page: StoredPage, meta: SetMeta): Promise<boolean> {
      if (failing()) throw new Error('memory adapter: injected failure')
      if (page.body.length > maxBodyBytes) return false
      const prefix = meta.prefix ?? ''
      if (meta.stamp !== null) {
        const s = meta.stamp
        if (entryNames({ ...meta, prefix }).some(n => (nameSeq.get(n) ?? 0) > s)) return false
      }
      const at = now()
      entries.set(key, {
        page: copyPage(page),
        tags: [...meta.tags],
        method: meta.method,
        path: meta.path,
        prefix,
        entryStamp: meta.stamp,
        storedAt: at,
        expiresAt: at + meta.ttlMs,
      })
      return true
    },
    async invalidate(args: InvalidateArgs): Promise<void> {
      if (failing()) throw new Error('memory adapter: injected failure')
      if (invalidateDelay > 0) {
        const ms = invalidateDelay
        invalidateDelay = 0
        await new Promise(r => setTimeout(r, ms))
      }
      // L7b: the marker first, at the seq the matching publish will take (seq + 1), so a set whose
      // stamp was read before this call is refused from now on; then the delete.
      mark(args, seq + 1)
      for (const [k, e] of entries) if (covers(args, e)) entries.delete(k)
    },
  }

  const push = (event: InvalidationEvent) => {
    const bytes = JSON.stringify(event).length
    const slot: Slot = { seq: event.seq, bytes: Math.min(bytes, OVERSIZE_EVENT), event: bytes > OVERSIZE_EVENT ? null : event }
    ring.push(slot)
    ringUsed += slot.bytes
    while (ring.length > ringCap || ringUsed > ringBytes) {
      const old = ring.shift()!
      ringUsed -= old.bytes
      dropped = old.seq
    }
  }

  const broadcast: CacheBroadcast = {
    async publish(args: InvalidateArgs, origin: string): Promise<number> {
      if (failing()) throw new Error('memory adapter: injected failure')
      seq += 1
      publishes += 1
      mark(args, seq)
      const event: InvalidationEvent = { seq, origin, args: structuredClone(args) }
      push(event)
      for (const s of subscribers) queueMicrotask(() => s.on(structuredClone(event)))
      return seq
    },
  }
  if (mode === 'push') {
    broadcast.subscribe = async (on, onGap) => {
      const sub = { on, onGap }
      subscribers.add(sub)
      return async () => {
        subscribers.delete(sub)
      }
    }
  }
  if (mode === 'pull') {
    broadcast.since = async (from: number): Promise<EpochSince> => {
      if (failing()) throw new Error('memory adapter: injected failure')
      const after = ring.filter(s => s.seq > from)
      const behind = from < dropped || after.some(s => s.event === null)
      return { gen: gen(), seq, behind, events: behind ? [] : after.map(s => structuredClone(s.event!)) }
    }
  }

  return {
    name: 'memory',
    runtimes: ['bun', 'workers'],
    store,
    ...(mode === 'none' ? {} : { broadcast }),
    __test: {
      regen() {
        genValue = randomGen()
        ring.length = 0
        ringUsed = 0
        dropped = seq
        for (const s of subscribers) queueMicrotask(() => s.onGap())
      },
      hangNextGet(ms = 2000) {
        hang = ms
      },
      failNext() {
        fail = true
      },
      delayNextInvalidate(ms: number) {
        invalidateDelay = ms
      },
      publishCount: () => publishes,
      size: () => entries.size,
    },
  }
}

function copyPage(p: StoredPage): StoredPage {
  return { status: p.status, headers: p.headers.map(([k, v]) => [k, v] as [string, string]), body: p.body.slice() }
}

function randomGen(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}
