import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  pathInto,
  entityEncode,
  resolveIslandContext,
  loadIslandManifest,
  type NativeIslandEntry,
} from './native-render.ts'

test('pathInto walks dotted paths and handles edge cases', () => {
  expect(pathInto({ data: { counter: { n: 1 } } }, 'data.counter')).toEqual({ n: 1 })
  expect(pathInto({ counter: 5 }, 'counter')).toBe(5)
  // missing segment → undefined
  expect(pathInto({ data: {} }, 'data.counter.n')).toBeUndefined()
  expect(pathInto({ a: 1 }, 'b')).toBeUndefined()
  // nullish data → undefined
  expect(pathInto(null, 'a')).toBeUndefined()
  expect(pathInto(undefined, 'a')).toBeUndefined()
  // empty path → whole object
  const whole = { a: 1, b: 2 }
  expect(pathInto(whole, '')).toBe(whole)
})

test('pathInto returns undefined for inherited / prototype keys (no chain walk)', () => {
  // Defense against prototype-chain reads + the downstream JSON.stringify(fn)
  // → undefined → entityEncode crash (T7 review HIGH-B).
  expect(pathInto({ a: 1 }, 'constructor')).toBeUndefined()
  expect(pathInto({ a: 1 }, '__proto__')).toBeUndefined()
  expect(pathInto({ a: 1 }, 'toString')).toBeUndefined()
  expect(pathInto({ a: 1 }, '__proto__.constructor')).toBeUndefined()
  // primitives mid-path don't traverse to String.prototype etc.
  expect(pathInto({ s: 'hi' }, 's.length')).toBeUndefined()
  // arrays: own indexed access still works
  expect(pathInto({ xs: [{ n: 7 }] }, 'xs.0')).toEqual({ n: 7 })
})

test('resolveIslandContext: a function-valued prop never crashes (serializes null)', () => {
  // If pathInto somehow yields a non-serializable value, JSON.stringify returns
  // undefined; the `?? null` / `?? "null"` guards keep entityEncode safe.
  const manifest: NativeIslandEntry[] = [
    { id: 'Fn', propsPath: 'fn', ssr: false, hydrate: 'load', sourcePath: '/x' },
  ]
  const out = resolveIslandContext(manifest, { fn: () => 1 })
  expect(out.island_Fn_props).toBe(entityEncode('null'))
})

test('entityEncode escapes & < > " in the right order, no double-encode', () => {
  // input contains literal backslashes (from the escaped quotes in JSON);
  // those pass through unchanged. Only & < > " are touched.
  const input = '{"x":"<a>&\\"b\\""}'
  const out = entityEncode(input)
  // exact expected: & first → &amp; ; then < > " each once.
  expect(out).toBe('{&quot;x&quot;:&quot;&lt;a&gt;&amp;\\&quot;b\\&quot;&quot;}')
  // & must not be double-encoded: no &amp;lt; / &amp;gt; / &amp;quot; anywhere
  expect(out).not.toContain('&amp;lt;')
  expect(out).not.toContain('&amp;gt;')
  expect(out).not.toContain('&amp;quot;')
  // all four chars are gone from the raw form
  expect(out).not.toContain('<')
  expect(out).not.toContain('>')
  expect(out).not.toContain('"')
})

test('resolveIslandContext: client-only entry contributes only _props', () => {
  const manifest: NativeIslandEntry[] = [
    { id: 'Counter', propsPath: 'data.counter', ssr: false, hydrate: 'load', sourcePath: '/x' },
  ]
  const data = { data: { counter: { n: 1 } } }
  const out = resolveIslandContext(manifest, data)
  expect(out.island_Counter_props).toBe(entityEncode(JSON.stringify({ n: 1 })))
  expect('island_Counter_html' in out).toBe(false)
  expect(Object.keys(out)).toEqual(['island_Counter_props'])
})

test('resolveIslandContext: ssr entry ALSO contributes only _props in T7 (no _html)', () => {
  const manifest: NativeIslandEntry[] = [
    { id: 'Counter', propsPath: 'data.counter', ssr: false, hydrate: 'load', sourcePath: '/x' },
    { id: 'Clock', propsPath: 'data.clock', ssr: true, hydrate: 'load', sourcePath: '/y' },
  ]
  const data = { data: { counter: { n: 1 }, clock: { t: 9 } } }
  const out = resolveIslandContext(manifest, data)
  expect(out.island_Clock_props).toBe(entityEncode(JSON.stringify({ t: 9 })))
  // T7 scope: ssr island does NOT yet contribute _html
  expect('island_Clock_html' in out).toBe(false)
})

test('resolveIslandContext: missing props serialize as null (not undefined)', () => {
  const manifest: NativeIslandEntry[] = [
    { id: 'Counter', propsPath: 'data.missing', ssr: false, hydrate: 'load', sourcePath: '/x' },
  ]
  const out = resolveIslandContext(manifest, { data: {} })
  expect(out.island_Counter_props).toBe(entityEncode('null'))
})

test('loadIslandManifest: reads from jinjaDir, missing file → null, caches reads', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brust-islands-'))
  const manifest: NativeIslandEntry[] = [
    { id: 'Counter', propsPath: 'data.counter', ssr: false, hydrate: 'load', sourcePath: '/x' },
  ]
  writeFileSync(path.join(dir, 'page.islands.json'), JSON.stringify(manifest))

  const first = loadIslandManifest('page', dir)
  expect(first).toEqual(manifest)

  // missing file → null
  expect(loadIslandManifest('nope', dir)).toBeNull()

  // second call hits cache: returns equal data (same object identity from cache)
  const second = loadIslandManifest('page', dir)
  expect(second).toBe(first)
})

test('loadIslandManifest: malformed JSON → null (no throw), cached', () => {
  // T7 review HIGH-A: a present-but-malformed manifest must degrade to null,
  // not throw out of the fast-lane native branch.
  const dir = mkdtempSync(path.join(tmpdir(), 'brust-islands-bad-'))
  writeFileSync(path.join(dir, 'broken.islands.json'), '{ not valid json ]')
  expect(loadIslandManifest('broken', dir)).toBeNull()
  // cached as null → second call also null, no re-read/throw
  expect(loadIslandManifest('broken', dir)).toBeNull()
})
