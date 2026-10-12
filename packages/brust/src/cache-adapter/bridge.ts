// The worker side of the native `cache` call kind (cache-adapter R2/R3): Rust asks this worker's
// adapter store to `get` or `set` one page. Every outcome is an A2 frame `[u32 LE meta_len][meta
// JSON][body]` in the slot; a hit too large for the slot leaves by `putFetchReply` (meta `heap`), a
// set body arrives by `takeFetchBody`. Never rejects (Rust's own timer bounds the get; the races
// here guarantee the call settles, so a hung adapter never pins the slot).
import type { HeapIo } from '../actions-bridge'
import type { CacheStore, SetMeta, StoredPage } from './types'

export interface CacheBridgeDeps {
  store: CacheStore | undefined
  getTimeoutMs: number
  maxBodyBytes: number
  count: (name: string) => void
}

/** A set gets this long before it is answered `{error}` (the slot is then released). */
export const SET_TIMEOUT_MS = 5000

type GetReq = { op: 'get'; key: string }
type SetReq = { op: 'set'; key: string; status: number; headers: [string, string][]; meta: SetMeta; heap: number }

const enc = new TextEncoder()
const EMPTY = new Uint8Array(0)

function frame(view: Uint8Array, slot: number, slots: number, meta: object, body: Uint8Array = EMPTY): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const dst = view.subarray(slot * sub, slot * sub + sub)
  let m = enc.encode(JSON.stringify(meta))
  if (4 + m.length + body.length > sub) {
    m = enc.encode(JSON.stringify({ error: 'cache reply does not fit the slot' }))
    body = EMPTY
  }
  new DataView(dst.buffer, dst.byteOffset, 4).setUint32(0, m.length, true)
  dst.set(m, 4)
  dst.set(body, 4 + m.length)
  return 4 + m.length + body.length
}

const TIMEOUT = Symbol('timeout')
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<typeof TIMEOUT>(r => (t = setTimeout(() => r(TIMEOUT), ms)))]).finally(() => clearTimeout(t))
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function runCache(requestJson: string, view: Uint8Array, slot: number, slots: number, io: HeapIo, deps: CacheBridgeDeps): Promise<number> {
  const out = (meta: object, body?: Uint8Array) => frame(view, slot, slots, meta, body)
  try {
    const store = deps.store
    if (!store) return out({ error: 'no cache adapter store in this worker' })
    const req = JSON.parse(requestJson) as GetReq | SetReq
    if (req.op === 'get') {
      const pending = store.get(req.key)
      pending.catch(() => {})
      const r = await within(pending, deps.getTimeoutMs)
      if (r === TIMEOUT) return out({ error: 'get timed out' })
      if (!r.page) return out({ hit: false, stamp: r.stamp })
      const p = r.page
      if (p.body.length > deps.maxBodyBytes) {
        deps.count('errors')
        return out({ hit: false, stamp: r.stamp })
      }
      const meta = { hit: true, status: p.status, headers: p.headers, stamp: r.stamp, entryStamp: r.entryStamp, storedAt: r.storedAt }
      const sub = Math.floor(view.byteLength / Math.max(1, slots))
      if (4 + enc.encode(JSON.stringify(meta)).length + p.body.length <= sub) return out(meta, p.body)
      if (!io.putReply(slot, p.body)) {
        deps.count('errors')
        return out({ hit: false, stamp: r.stamp })
      }
      return out({ ...meta, heap: p.body.length })
    }
    if (req.op === 'set') {
      const body = io.takeBody(slot)
      if (!body || body.length !== req.heap) return out({ error: `set body ${body ? `${body.length} != ${req.heap}` : 'missing'} bytes` })
      const page: StoredPage = { status: req.status, headers: req.headers, body }
      const pending = store.set(req.key, page, req.meta)
      pending.catch(() => {})
      const ok = await within(pending, SET_TIMEOUT_MS)
      if (ok === TIMEOUT) return out({ error: 'set timed out' })
      return out({ ok: ok === true })
    }
    return out({ error: `unknown cache op ${(req as { op?: unknown }).op}` })
  } catch (e) {
    return out({ error: describe(e) })
  }
}
