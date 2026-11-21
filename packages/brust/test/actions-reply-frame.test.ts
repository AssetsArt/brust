// F605 D1: the reply stage of runFetch builds the meta bytes once. This suite keeps the PREVIOUS path (a separate
// `metaLen` probe + `writeFramed`, copied verbatim) as the reference and asserts, for generated replies, the same return
// value, the same slot bytes, the same heap handover and the same console output.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { type FetchMeta, type HeapIo, setActionsLimits, writeFramed, writeReply } from '../src/actions-bridge'
import type { WsMeta } from '../src/actions/ws'

const enc = new TextEncoder()
const TEXT_PLAIN: [string, string][] = [['content-type', 'text/plain; charset=utf-8']]
const SLOTS = 2
const SUB = 4096
const MAX = 20_000

afterEach(() => setActionsLimits({ maxResponseBytes: 8_388_608 }))

type Out = { status: number; pairs: [string, string][]; body: Uint8Array; ws?: WsMeta }

/** The previous `runFetch` reply stage (actions-bridge.ts before F605), with `maxResponseBytes` = MAX. */
function reference(view: Uint8Array, slot: number, slots: number, out: Out, io: HeapIo): number {
  if (out.ws) return writeFramed(view, slot, slots, 101, out.pairs, out.body, undefined, out.ws)
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const metaLen = (m: FetchMeta) => enc.encode(JSON.stringify(m)).length
  if (4 + metaLen({ status: out.status, headers: out.pairs }) + out.body.length <= sub) return writeFramed(view, slot, slots, out.status, out.pairs, out.body)
  if (out.body.length > MAX) {
    console.error(`[brust] action response body ${out.body.length} bytes exceeds max_response_bytes ${MAX} — answered 500`)
    return writeFramed(view, slot, slots, 500, TEXT_PLAIN, enc.encode(`brust: action response exceeds ${MAX} bytes`))
  }
  if (4 + metaLen({ status: out.status, headers: out.pairs, heap: out.body.length }) > sub) return writeFramed(view, slot, slots, out.status, out.pairs, out.body)
  if (!io.putReply(slot, out.body)) throw new Error('heap reply declined by the server (F82)')
  return writeFramed(view, slot, slots, out.status, out.pairs, new Uint8Array(0), out.body.length)
}

// small seeded PRNG: the cases are the same on every run
let seed = 0x5eed1234
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 2 ** 32
}
const int = (n: number) => Math.floor(rnd() * n)
const NAMES = ['content-type', 'set-cookie', 'x-a', 'x-b', 'cache-control', 'vary', 'x-long-header-name-for-the-meta']
const VALUES = ['a', 'text/html; charset=utf-8', 'ünïcödé-€-日本語', 'a=b; Path=/; HttpOnly', '"quoted" \\ back', 'x'.repeat(40), '😀 emoji', '']
const pairs = (): [string, string][] => {
  const n = rnd() < 0.2 ? 0 : int(41)
  const out: [string, string][] = []
  for (let i = 0; i < n; i++) out.push([rnd() < 0.3 ? NAMES[int(2) + 1] : NAMES[int(NAMES.length)], rnd() < 0.15 ? VALUES[2] : rnd() < 0.1 ? 'y'.repeat(int(300)) : VALUES[int(VALUES.length)]])
  if (rnd() < 0.04) out.push(['x-huge', 'z'.repeat(SUB - 100 + int(300))]) // a meta at / over the slot
  return out
}
const bodyOf = (n: number): Uint8Array => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + n) & 255
  return b
}
const STATUSES = [200, 201, 204, 301, 400, 404, 500, 503]

function run(fn: (v: Uint8Array, s: number, n: number, o: Out, io: HeapIo) => number, out: Out, slot: number, putOk: boolean) {
  const view = new Uint8Array(new SharedArrayBuffer(SUB * SLOTS))
  view.fill(0xee) // the bytes outside a frame must be untouched too
  const puts: [number, number[]][] = []
  const io: HeapIo = { takeBody: () => null, putReply: (s, b) => (puts.push([s, Array.from(b)]), putOk) }
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let ret: number | string
  try {
    ret = fn(view, slot, SLOTS, out, io)
  } catch (e) {
    ret = `throw:${(e as Error).message}`
  }
  const logs = err.mock.calls.map((c) => c.join(' '))
  err.mockRestore()
  return { ret, bytes: Buffer.from(view).toString('base64'), puts, logs }
}

test('writeReply equals the previous reply stage for 6,000 generated replies (return, slot bytes, heap handover, logs)', () => {
  setActionsLimits({ maxResponseBytes: MAX })
  let cases = 0
  const seen = { fits: 0, exact: 0, oneOver: 0, heap: 0, overMax: 0, metaTooBig: 0, ws: 0, declined: 0 }
  for (let i = 0; i < 6000; i++) {
    const p = pairs()
    const status = STATUSES[int(STATUSES.length)]
    const metaBytes = enc.encode(JSON.stringify({ status, headers: p })).length
    const room = SUB - 4 - metaBytes // body length that fits exactly
    const kind = i % 8
    let len: number
    if (kind === 0) len = 0
    else if (kind === 1) len = int(200)
    else if (kind === 2) len = Math.max(0, room) // exactly fits (when the meta fits at all)
    else if (kind === 3) len = Math.max(0, room) + 1 // one over
    else if (kind === 4) len = SUB + int(MAX - SUB) // heap-sized
    else if (kind === 5) len = MAX + 1 + int(500) // over max_response_bytes
    else if (kind === 6) len = int(room > 0 ? room : 1)
    else len = int(MAX)
    const out: Out = { status, pairs: p, body: bodyOf(len) }
    if (i % 41 === 0) out.ws = { id: i, idleTimeout: 10 }
    const slot = i % SLOTS
    const putOk = i % 29 !== 0
    const a = run(reference, out, slot, putOk)
    const b = run(writeReply, out, slot, putOk)
    expect(b.ret).toBe(a.ret)
    expect(b.bytes).toBe(a.bytes)
    expect(b.puts).toEqual(a.puts)
    expect(b.logs).toEqual(a.logs)
    cases++
    if (out.ws) seen.ws++
    else if (len === room) seen.exact++
    else if (len === room + 1) seen.oneOver++
    else if (a.puts.length) seen.heap++
    else if (len > MAX) seen.overMax++
    else if (room < 0) seen.metaTooBig++
    else seen.fits++
    if (!putOk && a.puts.length) seen.declined++
  }
  expect(cases).toBe(6000)
  // the generator reaches every branch (a vacuous suite would pass trivially)
  expect(seen.fits).toBeGreaterThan(100)
  expect(seen.exact).toBeGreaterThan(50)
  expect(seen.heap).toBeGreaterThan(100)
  expect(seen.overMax).toBeGreaterThan(100)
  expect(seen.metaTooBig).toBeGreaterThan(5)
  expect(seen.ws).toBeGreaterThan(50)
  expect(seen.declined).toBeGreaterThan(5)
})
