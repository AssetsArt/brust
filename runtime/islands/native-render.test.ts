import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
  pathInto,
  entityEncode,
  resolveIslandContext,
  loadIslandManifest,
  type NativeIslandEntry,
} from './native-render.ts'
import StubIsland from './__fixtures__/StubIsland.tsx'

// Absolute paths to in-repo fixtures. Using in-repo fixtures (not tmpdir
// .tsx) so `import('react')` inside the fixture resolves via the project's
// node_modules — a tmpdir module would resolve bare specifiers from
// /var/folders/... and never reach the project's react.
const STUB_PATH = path.resolve(import.meta.dir, '__fixtures__/StubIsland.tsx')
const THROWING_PATH = path.resolve(import.meta.dir, '__fixtures__/ThrowingIsland.tsx')
const NODEFAULT_PATH = path.resolve(import.meta.dir, '__fixtures__/NoDefault.tsx')

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

test('resolveIslandContext: a function-valued prop never crashes (serializes null)', async () => {
  // If pathInto somehow yields a non-serializable value, JSON.stringify returns
  // undefined; the `?? null` / `?? "null"` guards keep entityEncode safe.
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Fn',
      instance: 0,
      propsPath: 'fn',
      ssr: false,
      hydrate: 'load',
      sourcePath: '/x',
    },
  ]
  const out = await resolveIslandContext(manifest, { fn: () => 1 })
  expect(out.island_0_props).toBe(entityEncode('null'))
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

test('resolveIslandContext: client-only entry contributes only _props', async () => {
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Counter',
      instance: 0,
      propsPath: 'data.counter',
      ssr: false,
      hydrate: 'load',
      sourcePath: '/x',
    },
  ]
  const data = { data: { counter: { n: 1 } } }
  const out = await resolveIslandContext(manifest, data)
  expect(out.island_0_props).toBe(entityEncode(JSON.stringify({ n: 1 })))
  expect('island_0_html' in out).toBe(false)
  expect(Object.keys(out)).toEqual(['island_0_props'])
})

test('resolveIslandContext: mixed manifest — ssr entry gets _html, client-only sibling does not', async () => {
  // Proves the `if (!entry.ssr) continue` gate: ssr entry pointed at a valid
  // in-repo fixture server-renders to _html; the client-only sibling gets only
  // _props. (This replaces the obsolete T7 "ssr contributes only _props" case.)
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Counter',
      instance: 0,
      propsPath: 'data.counter',
      ssr: false,
      hydrate: 'load',
      sourcePath: '/x',
    },
    {
      component: 'Clock',
      instance: 1,
      propsPath: 'data.clock',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
    },
  ]
  const data = { data: { counter: { n: 1 }, clock: { n: 9 } } }
  const out = await resolveIslandContext(manifest, data)
  // client-only sibling: props only, no _html
  expect(out.island_0_props).toBe(entityEncode(JSON.stringify({ n: 1 })))
  expect('island_0_html' in out).toBe(false)
  // ssr entry: both props AND server-rendered _html
  expect(out.island_1_props).toBe(entityEncode(JSON.stringify({ n: 9 })))
  expect(out.island_1_html).toBe(renderToString(createElement(StubIsland, { n: 9 })))
  expect(out.island_1_html).toBe('<span>9</span>')
})

test('resolveIslandContext: ssr entry _html equals renderToString of the stub with its props', async () => {
  // gating-Q1 empirical proof: the worker import()s the island SOURCE .tsx by
  // absolute path and renderToStrings it. Bun transpiles+runs the TSX.
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Stub',
      instance: 0,
      propsPath: 'data.stub',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
    },
  ]
  const data = { data: { stub: { n: 1 } } }
  const out = await resolveIslandContext(manifest, data)
  expect(out.island_0_html).toBe('<span>1</span>')
  expect(out.island_0_html).toBe(renderToString(createElement(StubIsland, { n: 1 })))
  expect(out.island_0_props).toBe(entityEncode(JSON.stringify({ n: 1 })))
})

test('resolveIslandContext: hydration byte-identity — renderToString props derive from the same roundtripped value as _props', async () => {
  // The prop the stub renders into markup must match what the client would
  // parse out of data-brust-props. Decode _props, JSON.parse it, and confirm
  // the stub rendered that exact value.
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Stub',
      instance: 0,
      propsPath: 'data.stub',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
    },
  ]
  const data = { data: { stub: { n: 42 } } }
  const out = await resolveIslandContext(manifest, data)
  // entity-DEcode the props string back to raw JSON, then parse.
  const decoded = out.island_0_props
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
  const parsed = JSON.parse(decoded) as { n: number }
  expect(parsed).toEqual({ n: 42 })
  // the stub rendered the SAME n the client would parse
  expect(out.island_0_html).toBe(`<span>${parsed.n}</span>`)
})

test('resolveIslandContext: contained failure — component that throws in render → no _html, no throw', async () => {
  // Production-realistic SSR failure: a valid default export that throws inside
  // render. resolveIslandContext must NOT throw; the entry degrades to props
  // only (empty mount, client recovers). console.error is the invariant working.
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Boom',
      instance: 0,
      propsPath: 'data.boom',
      ssr: true,
      hydrate: 'load',
      sourcePath: THROWING_PATH,
    },
  ]
  const data = { data: { boom: { n: 1 } } }
  const out = await resolveIslandContext(manifest, data)
  expect('island_0_html' in out).toBe(false)
  expect(out.island_0_props).toBe(entityEncode(JSON.stringify({ n: 1 })))
})

test('resolveIslandContext: contained failure — source with no default export → no _html, no throw', async () => {
  // Hits the `typeof Component !== 'function'` guard.
  const manifest: NativeIslandEntry[] = [
    {
      component: 'NoDef',
      instance: 0,
      propsPath: 'data.x',
      ssr: true,
      hydrate: 'load',
      sourcePath: NODEFAULT_PATH,
    },
  ]
  const data = { data: { x: { n: 1 } } }
  const out = await resolveIslandContext(manifest, data)
  expect('island_0_html' in out).toBe(false)
  expect(out.island_0_props).toBe(entityEncode(JSON.stringify({ n: 1 })))
})

test('resolveIslandContext: missing props serialize as null (not undefined)', async () => {
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Counter',
      instance: 0,
      propsPath: 'data.missing',
      ssr: false,
      hydrate: 'load',
      sourcePath: '/x',
    },
  ]
  const out = await resolveIslandContext(manifest, { data: {} })
  expect(out.island_0_props).toBe(entityEncode('null'))
})

test('loadIslandManifest: reads from jinjaDir, missing file → null, caches reads', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brust-islands-'))
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Counter',
      instance: 0,
      propsPath: 'data.counter',
      ssr: false,
      hydrate: 'load',
      sourcePath: '/x',
    },
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
