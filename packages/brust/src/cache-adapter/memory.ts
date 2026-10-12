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
  publishCount(): number
  /** Stored entries (expired ones included). */
  size(): number
}

export type MemoryAdapter = CacheAdapter & { store: CacheStore; __test: MemoryAdapterTest }

const pathName = (method: string | undefined, path: string) => `${method ?? 'GET'} ${path}`

export function memoryAdapter(o: MemoryAdapterOptions = {}): MemoryAdapter {
  const mode = o.broadcast ?? 'push'
  const ringCap = o.ring ?? 1024
  const ringBytes = o.ringBytes ?? 1_048_576
  const maxBodyBytes = o.maxBodyBytes ?? 8_388_608
  const now = o.now ?? Date.now
  const entries = new Map<string, Entry>()
  const tagSeq = new Map<string, number>()
  const pathSeq = new Map<string, number>()
  let seq = 0
  let gen = randomGen()
  const ring: Slot[] = []
  let ringUsed = 0
  /** The highest seq no longer in the ring (a reader at or below seq-1 of it is behind). */
  let dropped = 0
  let publishes = 0
  let hang: number | null = null
  let fail = false
  const subscribers = new Set<{ on: (e: InvalidationEvent) => void; onGap: () => void }>()

  const guarded = mode !== 'none'
  const failing = () => {
    if (!fail) return false
    fail = false
    return true
  }
  const raise = (m: Map<string, number>, k: string, s: number) => m.set(k, Math.max(m.get(k) ?? 0, s))
  const mark = (args: InvalidateArgs, s: number) => {
    for (const t of args.tags ?? []) raise(tagSeq, t, s)
    if (args.path !== undefined) raise(pathSeq, pathName(args.method, args.path), s)
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
      if (meta.stamp !== null) {
        const s = meta.stamp
        const stale = (m: Map<string, number>, k: string) => (m.get(k) ?? 0) > s
        if (meta.tags.some(t => stale(tagSeq, t)) || stale(pathSeq, pathName(meta.method, meta.path))) return false
      }
      const at = now()
      entries.set(key, {
        page: copyPage(page),
        tags: [...meta.tags],
        method: meta.method,
        path: meta.path,
        entryStamp: meta.stamp,
        storedAt: at,
        expiresAt: at + meta.ttlMs,
      })
      return true
    },
    async invalidate(args: InvalidateArgs): Promise<void> {
      if (failing()) throw new Error('memory adapter: injected failure')
      // L7b: the marker first, at the seq the matching publish will take (seq + 1), so a set whose
      // stamp was read before this call is refused from now on; then the delete.
      mark(args, seq + 1)
      const tags = new Set(args.tags ?? [])
      const p = args.path === undefined ? null : pathName(args.method, args.path)
      for (const [k, e] of entries) {
        if (e.tags.some(t => tags.has(t)) || (p !== null && pathName(e.method, e.path) === p)) entries.delete(k)
      }
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
      return { gen, seq, behind, events: behind ? [] : after.map(s => structuredClone(s.event!)) }
    }
  }

  return {
    name: 'memory',
    runtimes: ['bun', 'workers'],
    store,
    ...(mode === 'none' ? {} : { broadcast }),
    __test: {
      regen() {
        gen = randomGen()
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
