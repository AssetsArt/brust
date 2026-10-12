// One page = one binary string (cache-redis R3): [u32 LE meta_len][meta JSON][body].
import type { StoredPage } from '@brust/core/cache-adapter'

export interface FrameMeta {
  v: 1
  status: number
  headers: [string, string][]
  entryStamp: number | null
  storedAt: number
  tags: string[]
  method: string
  path: string
}

export interface DecodedFrame {
  page: StoredPage
  entryStamp: number | null
  storedAt: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodeFrame(page: StoredPage, m: Omit<FrameMeta, 'v' | 'status' | 'headers'>): Uint8Array {
  const meta = enc.encode(JSON.stringify({ v: 1, status: page.status, headers: page.headers, ...m } satisfies FrameMeta))
  const out = new Uint8Array(4 + meta.length + page.body.length)
  new DataView(out.buffer).setUint32(0, meta.length, true)
  out.set(meta, 4)
  out.set(page.body, 4 + meta.length)
  return out
}

/** `null` = a frame of an unknown version (a miss); throws on a truncated or corrupt frame. */
export function decodeFrame(buf: Uint8Array): DecodedFrame | null {
  if (buf.length < 4) throw new Error('cache-redis: truncated page frame')
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true)
  if (4 + len > buf.length) throw new Error('cache-redis: page frame meta length exceeds the frame')
  const meta = JSON.parse(dec.decode(buf.subarray(4, 4 + len))) as Partial<FrameMeta> & { v?: unknown }
  if (meta.v !== 1) return null
  if (typeof meta.status !== 'number' || !Array.isArray(meta.headers)) throw new Error('cache-redis: corrupt page frame meta')
  return {
    page: { status: meta.status, headers: meta.headers, body: buf.slice(4 + len) },
    entryStamp: typeof meta.entryStamp === 'number' ? meta.entryStamp : null,
    storedAt: typeof meta.storedAt === 'number' ? meta.storedAt : 0,
  }
}
