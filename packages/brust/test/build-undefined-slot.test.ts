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
