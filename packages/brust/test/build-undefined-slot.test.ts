// F512: a precompute output that is `undefined` (a `find` that missed) keeps its slot as `null`, so
// brust-core does not read the dropped JSON key as a stale dist/jobs.js.
import { expect, test } from 'bun:test'
import { SLOTS_HELPER } from '../src/build/bundle'

const wrap = (body: (p: any) => any): ((p: any) => any) => {
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${SLOTS_HELPER}\nreturn __slots`)
  const make = new Function(`${js}`) as () => (f: unknown) => (p: any) => any
  return make()(body)
}

test('an undefined top-level output survives JSON as null', () => {
  const out = JSON.parse(JSON.stringify(wrap(() => ({ _s1: 'a', _s4: undefined, _s5: undefined }))({})))
  expect(out).toEqual({ _s1: 'a', _s4: null, _s5: null })
  expect('_s4' in out).toBe(true)
})

test('values present, falsy values and nested undefined stay as they are', () => {
  const r = wrap(() => ({ _s1: 0, _s2: '', _s3: false, _s4: null, _s5: { name: 'x', gone: undefined }, _s6: [undefined, 1] }))({})
  expect(r._s1).toBe(0)
  expect(r._s2).toBe('')
  expect(r._s3).toBe(false)
  expect(r._s4).toBeNull()
  expect(r._s5).toEqual({ name: 'x', gone: undefined })
  expect(r._s6).toEqual([undefined, 1])
})

test('a non-object result passes through', () => {
  expect(wrap(() => 'html')({})).toBe('html')
  expect(wrap(() => undefined)({})).toBeUndefined()
})

test('the generated jobs module wraps every precompute', async () => {
  const src = await Bun.file(new URL('../src/build/bundle.ts', import.meta.url)).text()
  expect(src).toContain('precompute: __slots(j${n}.precompute)')
})

// F585: the values JSON cannot carry are tagged, at the top level and in a top-level array's items only.
const T = '\u0000js'
const wire = (r: Record<string, unknown>, helper = SLOTS_HELPER) => {
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${helper}\nreturn __slots`)
  const slots = (new Function(js) as () => (f: unknown) => (p: unknown) => unknown)()
  return JSON.parse(JSON.stringify(slots(() => r)({})))
}

test('NaN, ±Infinity and a bigint are tagged; -0 and finite numbers are not', () => {
  expect(wire({ a: NaN, b: Infinity, c: -Infinity, d: 10n, e: -0n, f: -0, g: 1.5 })).toEqual({
    a: { [T]: 'NaN' }, b: { [T]: 'Infinity' }, c: { [T]: '-Infinity' }, d: { [T]: '10n' }, e: { [T]: '0n' }, f: 0, g: 1.5,
  })
})

test("a top-level array's items are tagged on a copy; the app's array is not changed", () => {
  const arr = [NaN, 1, 2n, 'x', [NaN]]
  expect(wire({ a: arr })).toEqual({ a: [{ [T]: 'NaN' }, 1, { [T]: '2n' }, 'x', [null]] })
  expect(Number.isNaN(arr[0])).toBe(true)
  expect(arr[2]).toBe(2n)
  const plain = [1, 'a']
  const r = { a: plain }
  wire(r)
  expect(r.a).toBe(plain)
})

test('an app object with the reserved key is escaped at both depths; nested values are left to JSON', () => {
  const own = { [T]: 'NaN' }
  expect(wire({ a: own, b: [own], c: { n: NaN } })).toEqual({ a: { [T]: { o: own } }, b: [{ [T]: { o: own } }], c: { n: null } })
})

test('the dev wrapper also tags a top-level object-like output with its kind; production does not', async () => {
  const { DEV_SLOTS_HELPER } = await import('../src/build/bundle')
  const r = () => ({ a: { x: 1 }, b: new Date(0), c: new Map(), d: new Set(), e: [{ x: 1 }], f: NaN })
  expect(wire(r(), DEV_SLOTS_HELPER)).toEqual({
    a: { [T]: { k: 'object', v: { x: 1 } } },
    b: { [T]: { k: 'Date', v: '1970-01-01T00:00:00.000Z' } },
    c: { [T]: { k: 'Map', v: {} } },
    d: { [T]: { k: 'Set', v: {} } },
    e: [{ x: 1 }],
    f: { [T]: 'NaN' },
  })
  expect(wire(r())).toEqual({ a: { x: 1 }, b: '1970-01-01T00:00:00.000Z', c: {}, d: {}, e: [{ x: 1 }], f: { [T]: 'NaN' } })
  expect(SLOTS_HELPER).not.toContain('__dev')
})

test('a bigint the wrapper does not tag, in a JOB reply, is its digits, not a failed reply; any other reply keeps the failure', async () => {
  const { toJson } = await import('../src/handlers')
  expect(toJson({ a: { b: 10n }, c: [1n] }, true)).toBe('{"a":{"b":"10"},"c":["1"]}')
  expect(toJson({ a: { b: 10n } })).toContain('response not serialisable')
  expect(toJson({ a: 1 })).toBe('{"a":1}')
  const loop: Record<string, unknown> = {}
  loop.self = loop
  expect(toJson(loop)).toContain('response not serialisable')
})
