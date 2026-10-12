import { expect, test } from 'bun:test'
import { decodeEntry, encodeEntry } from '../src/frame'

const m = { tags: ['a'], method: 'GET', path: '/x', entryStamp: 3, storedAt: 10, expiresAt: 20 }
test('all 256 byte values round-trip; header order and repeats are kept', () => {
  const body = Uint8Array.from({ length: 256 }, (_, i) => i)
  const headers: [string, string][] = [['b', '1'], ['a', '2'], ['b', '3']]
  const d = decodeEntry(encodeEntry({ status: 201, headers, body }, m))!
  expect(Array.from(d.page.body)).toEqual(Array.from(body))
  expect(d.page.headers).toEqual(headers)
  expect(d.page.status).toBe(201)
  expect(d.meta.entryStamp).toBe(3)
})
test('truncated, oversized meta_len and wrong version are null', () => {
  const f = encodeEntry({ status: 200, headers: [], body: new Uint8Array(4) }, m)
  expect(decodeEntry(f.subarray(0, 2))).toBeNull()
  expect(decodeEntry(f.subarray(0, 10))).toBeNull()
  const big = f.slice(); new DataView(big.buffer).setUint32(0, 1 << 30, true)
  expect(decodeEntry(big)).toBeNull()
  const head = new TextEncoder().encode('{"v":2,"status":200,"headers":[]}')
  const v2 = new Uint8Array(4 + head.length); new DataView(v2.buffer).setUint32(0, head.length, true); v2.set(head, 4)
  expect(decodeEntry(v2)).toBeNull()
})
