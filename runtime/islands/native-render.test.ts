import { test, expect, describe, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server.node'
import {
  pathInto,
  entityEncode,
  resolveIslandContext,
  loadIslandManifest,
  loadComponentManifest,
  resolveComponentContext,
  type NativeIslandEntry,
  type IslandCache,
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

// ── T5: ISR cache get/set in resolveIslandContext ──────────────────────────

function fakeCache() {
  const store = new Map<string, { html: string; props: string }>()
  const calls = { get: 0, set: 0 }
  const cache: IslandCache = {
    get(k: string) {
      calls.get++
      return store.get(k) ?? null
    },
    set(k: string, _t: string[], _ttl: number | undefined, html: string, props: string) {
      calls.set++
      store.set(k, { html, props })
    },
  }
  return { cache, calls, store }
}

test('resolveIslandContext ISR: miss renders once and writes cache', async () => {
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Stub',
      instance: 0,
      propsPath: 'data.stub',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
      keyPath: 'data.key',
      tagsPath: 'data.tags',
      revalidate: 60,
    },
  ]
  const { cache, calls } = fakeCache()
  const data = { data: { stub: { n: 1 }, key: 'post:1', tags: ['post'] } }
  const out = await resolveIslandContext(manifest, data, cache)
  expect(calls.get).toBe(1)
  expect(calls.set).toBe(1)
  expect(out.island_0_html).toBeDefined()
  expect(out.island_0_html).toBe('<span>1</span>')
})

test('resolveIslandContext ISR: hit serves FROZEN pair without re-rendering (hydration-safety)', async () => {
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Stub',
      instance: 0,
      propsPath: 'data.stub',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
      keyPath: 'data.key',
    },
  ]
  const { cache, calls } = fakeCache()
  // 1st request: populate the cache (n: 1).
  const first = await resolveIslandContext(
    manifest,
    { data: { stub: { n: 1 }, key: 'post:1' } },
    cache,
  )
  const frozenProps = first.island_0_props
  const frozenHtml = first.island_0_html
  expect(calls.set).toBe(1)
  // 2nd request: SAME key, MUTATED live props (n: 999). Must NOT re-render or
  // re-set; the served pair must be the FROZEN one from the first render.
  const second = await resolveIslandContext(
    manifest,
    { data: { stub: { n: 999 }, key: 'post:1' } },
    cache,
  )
  expect(calls.set).toBe(1) // NOT called again
  expect(second.island_0_html).toBe(frozenHtml)
  // hydration-safety invariant: served props are the FROZEN ones, NOT the
  // mutated live props (which would entity-encode to {"n":999}).
  expect(second.island_0_props).toBe(frozenProps)
  expect(second.island_0_props).toBe(entityEncode(JSON.stringify({ n: 1 })))
  expect(second.island_0_props).not.toBe(entityEncode(JSON.stringify({ n: 999 })))
})

test('resolveIslandContext ISR: undefined key (no keyPath value) → uncached render', async () => {
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Stub',
      instance: 0,
      propsPath: 'data.stub',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
      keyPath: 'data.missingKey',
    },
  ]
  const { cache, calls } = fakeCache()
  const data = { data: { stub: { n: 1 } } }
  const out = await resolveIslandContext(manifest, data, cache)
  expect(calls.get).toBe(0)
  expect(calls.set).toBe(0)
  expect(out.island_0_html).toBeDefined()
  expect(out.island_0_html).toBe('<span>1</span>')
})

test('resolveIslandContext ISR: non-isr ssr island (no keyPath) leaves cache untouched', async () => {
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
  const { cache, calls } = fakeCache()
  const data = { data: { stub: { n: 1 } } }
  const out = await resolveIslandContext(manifest, data, cache)
  expect(calls.get).toBe(0)
  expect(calls.set).toBe(0)
  expect(out.island_0_html).toBe('<span>1</span>')
})

test('resolveIslandContext ISR: literal key caches under the literal (no keyPath)', async () => {
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Stub',
      instance: 0,
      propsPath: 'data.stub',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
      keyLiteral: 'globalStub',
      tagsLiteral: ['g'],
    },
  ]
  const { cache, calls, store } = fakeCache()
  const out = await resolveIslandContext(manifest, { data: { stub: { n: 1 } } }, cache)
  expect(calls.set).toBe(1)
  expect(out.island_0_html).toBe('<span>1</span>')
  expect(store.has('globalStub')).toBe(true) // cached under the LITERAL key, not a path
})

test('resolveIslandContext ISR: literal key HIT serves frozen pair, no re-render', async () => {
  const manifest: NativeIslandEntry[] = [
    {
      component: 'Stub',
      instance: 0,
      propsPath: 'data.stub',
      ssr: true,
      hydrate: 'load',
      sourcePath: STUB_PATH,
      keyLiteral: 'globalStub',
    },
  ]
  const { cache, calls, store } = fakeCache()
  // Pre-seed the cache under the literal key with a frozen pair.
  store.set('globalStub', { html: '<span>frozen</span>', props: 'FROZEN_PROPS' })
  const out = await resolveIslandContext(manifest, { data: { stub: { n: 42 } } }, cache)
  expect(calls.set).toBe(0) // hit → no write
  expect(out.island_0_html).toBe('<span>frozen</span>')
  expect(out.island_0_props).toBe('FROZEN_PROPS') // frozen props served, not live
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

describe('resolveComponentContext', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'brust-comp-ctx-'))

    // Write a simple component
    writeFileSync(
      path.join(dir, 'SimpleComp.tsx'),
      `import { createElement } from 'react'
export default function SimpleComp({ label }: { label: string }) {
  return createElement('p', null, label)
}`,
    )

    // Write the factory — use an absolute path for the react import so the
    // factory resolves react from the project's node_modules even when Bun
    // imports it from a tmpdir (bare 'react' would fail outside the project
    // tree; same constraint as the in-repo StubIsland fixture).
    const reactPath = require.resolve('react')
    writeFileSync(
      path.join(dir, 'TestPage.factory.ts'),
      `import { createElement as h } from ${JSON.stringify(reactPath)}
export const factories: Array<(ctx: any) => any> = [
  (ctx: any) => h('p', null, ctx.greeting),
]`,
    )

    // Write the components.json manifest
    writeFileSync(
      path.join(dir, 'TestPage.components.json'),
      JSON.stringify([
        { component: 'SimpleComp', instance: 0, sourcePath: path.join(dir, 'SimpleComp.tsx') },
      ]),
    )
  })

  test('loadComponentManifest returns null for missing file', () => {
    const result = loadComponentManifest('NonExistent', dir)
    expect(result).toBeNull()
  })

  test('loadComponentManifest returns parsed entries', () => {
    const result = loadComponentManifest('TestPage', dir)
    expect(result).not.toBeNull()
    expect(result![0].component).toBe('SimpleComp')
  })

  test('resolveComponentContext renders factory and returns comp_0_html', async () => {
    const manifest = loadComponentManifest('TestPage', dir)!
    const ctx = await resolveComponentContext(
      manifest,
      { greeting: 'hello world' },
      'TestPage',
      dir,
    )
    expect(ctx.comp_0_html).toContain('hello world')
    expect(ctx.comp_0_html).toContain('<p')
  })

  test('resolveComponentContext degrades to empty string on factory throw', async () => {
    const failDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-fail-'))
    writeFileSync(
      path.join(failDir, 'FailPage.factory.ts'),
      `export const factories: Array<(ctx: any) => any> = [() => { throw new Error('boom') }]`,
    )
    writeFileSync(
      path.join(failDir, 'FailPage.components.json'),
      JSON.stringify([{ component: 'Fail', instance: 0, sourcePath: '/nonexistent' }]),
    )
    const manifest = loadComponentManifest('FailPage', failDir)!
    const ctx = await resolveComponentContext(manifest, {}, 'FailPage', failDir)
    expect(ctx.comp_0_html).toBe('')
  })

  test('ISR miss renders once and writes cache (props is "")', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-'))
    const reactPath = require.resolve('react')
    writeFileSync(
      path.join(isrDir, 'IsrPage.factory.ts'),
      `import { createElement as h } from ${JSON.stringify(reactPath)}
export const factories: Array<(ctx: any) => any> = [
  (ctx: any) => h('p', null, ctx.label),
]`,
    )
    writeFileSync(
      path.join(isrDir, 'IsrPage.components.json'),
      JSON.stringify([
        {
          component: 'Layout',
          instance: 0,
          sourcePath: '/x',
          keyPath: 'cacheKey',
          tagsPath: 'cacheTags',
          revalidate: 60,
        },
      ]),
    )
    const manifest = loadComponentManifest('IsrPage', isrDir)!
    const { cache, calls, store } = fakeCache()
    const data = { label: 'hi', cacheKey: 'layout:1', cacheTags: ['layout'] }
    const out = await resolveComponentContext(manifest, data, 'IsrPage', isrDir, cache)
    expect(calls.get).toBe(1)
    expect(calls.set).toBe(1)
    expect(out.comp_0_html).toContain('hi')
    // Invariant 5: components store props="" (no separate hydration attr).
    expect(store.get('layout:1')!.props).toBe('')
  })

  test('ISR hit skips the factory and serves cached html', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-hit-'))
    // Factory throws if ever called — proves a hit never invokes it.
    writeFileSync(
      path.join(isrDir, 'HitPage.factory.ts'),
      `export const factories: Array<(ctx: any) => any> = [
  () => { throw new Error('factory must not run on a hit') },
]`,
    )
    writeFileSync(
      path.join(isrDir, 'HitPage.components.json'),
      JSON.stringify([{ component: 'Layout', instance: 0, sourcePath: '/x', keyPath: 'cacheKey' }]),
    )
    const manifest = loadComponentManifest('HitPage', isrDir)!
    const { cache } = fakeCache()
    // Pre-seed the cache for the key.
    cache.set('layout:9', [], undefined, '<p>cached</p>', '')
    const out = await resolveComponentContext(
      manifest,
      { cacheKey: 'layout:9' },
      'HitPage',
      isrDir,
      cache,
    )
    expect(out.comp_0_html).toBe('<p>cached</p>')
  })

  test('ISR non-string key → uncached render, no cache write', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-badkey-'))
    const reactPath = require.resolve('react')
    writeFileSync(
      path.join(isrDir, 'BadKeyPage.factory.ts'),
      `import { createElement as h } from ${JSON.stringify(reactPath)}
export const factories: Array<(ctx: any) => any> = [(ctx: any) => h('p', null, 'x')]`,
    )
    writeFileSync(
      path.join(isrDir, 'BadKeyPage.components.json'),
      JSON.stringify([{ component: 'Layout', instance: 0, sourcePath: '/x', keyPath: 'cacheKey' }]),
    )
    const manifest = loadComponentManifest('BadKeyPage', isrDir)!
    const { cache, calls } = fakeCache()
    // cacheKey resolves to a number → non-string → uncached.
    const out = await resolveComponentContext(
      manifest,
      { cacheKey: 123 },
      'BadKeyPage',
      isrDir,
      cache,
    )
    expect(calls.set).toBe(0)
    expect(out.comp_0_html).toContain('x')
  })

  test('ISR factory throw after a miss → empty string, cache NOT poisoned', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-throw-'))
    writeFileSync(
      path.join(isrDir, 'ThrowPage.factory.ts'),
      `export const factories: Array<(ctx: any) => any> = [() => { throw new Error('boom') }]`,
    )
    writeFileSync(
      path.join(isrDir, 'ThrowPage.components.json'),
      JSON.stringify([{ component: 'Layout', instance: 0, sourcePath: '/x', keyPath: 'cacheKey' }]),
    )
    const manifest = loadComponentManifest('ThrowPage', isrDir)!
    const { cache, calls } = fakeCache()
    const out = await resolveComponentContext(
      manifest,
      { cacheKey: 'layout:throw' },
      'ThrowPage',
      isrDir,
      cache,
    )
    expect(out.comp_0_html).toBe('')
    expect(calls.set).toBe(0) // throwing render must not write the cache
  })

  test('ISR literal key — miss renders + caches under the literal, no pathInto needed', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-lit-'))
    const reactPath = require.resolve('react')
    writeFileSync(
      path.join(d, 'LitPage.factory.ts'),
      `import { createElement as h } from ${JSON.stringify(reactPath)}\nexport const factories: Array<(ctx: any) => any> = [(ctx: any) => h('p', null, 'x')]`,
    )
    writeFileSync(
      path.join(d, 'LitPage.components.json'),
      JSON.stringify([
        {
          component: 'Layout',
          instance: 0,
          sourcePath: '/x',
          keyLiteral: 'navbar',
          tagsLiteral: ['nav'],
        },
      ]),
    )
    const manifest = loadComponentManifest('LitPage', d)!
    const { cache, calls, store } = fakeCache()
    const out = await resolveComponentContext(manifest, {}, 'LitPage', d, cache)
    expect(calls.set).toBe(1)
    expect(out.comp_0_html).toContain('x')
    expect(store.has('navbar')).toBe(true) // cached under the literal key
  })

  test('ISR literal key — hit serves frozen html, factory not called', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-lit-hit-'))
    writeFileSync(
      path.join(d, 'LitHit.factory.ts'),
      `export const factories: Array<(ctx: any) => any> = [() => { throw new Error('must not run on hit') }]`,
    )
    writeFileSync(
      path.join(d, 'LitHit.components.json'),
      JSON.stringify([
        { component: 'Layout', instance: 0, sourcePath: '/x', keyLiteral: 'navbar' },
      ]),
    )
    const manifest = loadComponentManifest('LitHit', d)!
    const { cache } = fakeCache()
    cache.set('navbar', [], undefined, '<p>cached</p>', '')
    const out = await resolveComponentContext(manifest, {}, 'LitHit', d, cache)
    expect(out.comp_0_html).toBe('<p>cached</p>')
  })
})
