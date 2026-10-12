import { describe, expect, test } from 'bun:test'
import { decodeFrame, encodeFrame } from '../src/frame'

const meta = { entryStamp: 7, storedAt: 1234, tags: ['a', 'b'], method: 'GET', path: '/x' }

describe('frame', () => {
  test('round trip with all 256 byte values and repeated headers', () => {
    const body = new Uint8Array(256).map((_, i) => i)
    const headers: [string, string][] = [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['content-type', 'text/html']]
    const f = decodeFrame(encodeFrame({ status: 203, headers, body }, meta))!
    expect(f.page.status).toBe(203)
    expect(f.page.headers).toEqual(headers)
    expect(Array.from(f.page.body)).toEqual(Array.from(body))
    expect([f.entryStamp, f.storedAt]).toEqual([7, 1234])
  })
  test('a null entryStamp and an empty body', () => {
    const f = decodeFrame(encodeFrame({ status: 200, headers: [], body: new Uint8Array() }, { ...meta, entryStamp: null }))!
    expect(f.entryStamp).toBeNull()
    expect(f.page.body.length).toBe(0)
  })
  test('an unknown version is a miss', () => {
    const m = new TextEncoder().encode(JSON.stringify({ v: 2 }))
    const b = new Uint8Array(4 + m.length)
    new DataView(b.buffer).setUint32(0, m.length, true)
    b.set(m, 4)
    expect(decodeFrame(b)).toBeNull()
  })
  test('truncated frames throw', () => {
    expect(() => decodeFrame(new Uint8Array([1, 2]))).toThrow('truncated')
    const b = new Uint8Array(8)
    new DataView(b.buffer).setUint32(0, 999, true)
    expect(() => decodeFrame(b)).toThrow('meta length')
  })
})
