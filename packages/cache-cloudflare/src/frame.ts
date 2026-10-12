// KV / DO-row value: [u32 LE meta_len][meta JSON][body] (spec §5.1, the Redis framing). No KV metadata: headers + tags would pass its 1024-byte cliff.
import type { StoredPage } from '@brust/core/cache-adapter'

export interface EntryMeta {
  v: 1
  status: number
  headers: [string, string][]
  tags: string[]
  method: string
  path: string
  entryStamp: number | null
  storedAt: number
  expiresAt: number
}

export function encodeEntry(page: StoredPage, meta: Omit<EntryMeta, 'v' | 'status' | 'headers'>): Uint8Array {
  const m: EntryMeta = { v: 1, status: page.status, headers: page.headers, ...meta }
  const head = new TextEncoder().encode(JSON.stringify(m))
  const out = new Uint8Array(4 + head.length + page.body.length)
  new DataView(out.buffer).setUint32(0, head.length, true)
  out.set(head, 4)
  out.set(page.body, 4 + head.length)
  return out
}

export function decodeEntry(u8: Uint8Array): { page: StoredPage; meta: EntryMeta } | null {
  if (u8.length < 4) return null
  const n = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, true)
  if (n > u8.length - 4) return null
  let meta: EntryMeta
  try {
    meta = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + n)))
  } catch {
    return null
  }
  if (!meta || meta.v !== 1 || !Array.isArray(meta.headers)) return null
  return { page: { status: meta.status, headers: meta.headers, body: u8.slice(4 + n) }, meta }
}
