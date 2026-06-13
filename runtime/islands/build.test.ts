// Unit tests for scanIslandChunks — the React-path island chunk discovery
// (component-addressed islands). It is pure file I/O (regex scan over page sources
// + scanImports resolution), so we drive it against self-contained temp files.
//
// scanImports only records a default import when a resolved candidate file
// actually exists on disk (existsSync gate), so every fixture below — routes
// entry, pages, AND each island component — is a REAL file with a real
// extension and a line-start `import X from './x'`.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { scanIslandChunks } from './build.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'brust-islands-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content: string): string {
  const abs = resolve(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

test('dedupes a reused component and lists each distinct one once', () => {
  const counter = write('Counter.tsx', 'export default function Counter() { return null }\n')
  const clock = write('Clock.tsx', 'export default function Clock() { return null }\n')
  // Page imports both components; uses Counter TWICE (client + ssr island) and
  // Clock once → expect exactly 2 chunks, Counter deduped to one entry.
  write(
    'Home.tsx',
    `import Counter from './Counter'\n` +
      `import Clock from './Clock'\n` +
      `export default function Home() {\n` +
      `  return (<div>\n` +
      `    <Island component={Counter} props={{ n: 1 }} />\n` +
      `    <Island component={Counter} props={{ n: 2 }} ssr hydrate="visible" />\n` +
      `    <Island component={Clock} props={{}} />\n` +
      `  </div>)\n` +
      `}\n`,
  )
  const entry = write('routes.ts', `import Home from './Home'\nexport default [Home]\n`)

  const chunks = scanIslandChunks(entry)

  expect(chunks.size).toBe(2)
  // Keyed by content-addressed id (`<Name>_<hash>`); assert by source value.
  expect([...chunks.values()]).toContain(counter)
  expect([...chunks.values()]).toContain(clock)
})

test('discovers an island nested in a component a page imports (transitive)', () => {
  // Regression: routes → page → Layout, and the <Island> lives in Layout (a
  // shared shell), NOT directly in the page. The scanner must follow the import
  // graph transitively or the chunk is never built and the browser 404s.
  // (This is exactly pokedex after PageLayout absorbed the TeamBuilder dock.)
  const dock = write('Dock.tsx', 'export default function Dock() { return null }\n')
  write(
    'Layout.tsx',
    `import Dock from './Dock'\n` +
      `export default function Layout({ children }: any) {\n` +
      `  return (<div><Island component={Dock} props={{}} ssr />{children}</div>)\n` +
      `}\n`,
  )
  // Page imports Layout (not Dock); has no <Island> of its own.
  write(
    'Home.tsx',
    `import Layout from './Layout'\n` +
      `export default function Home() { return <Layout><p>hi</p></Layout> }\n`,
  )
  const entry = write('routes.ts', `import Home from './Home'\nexport default [Home]\n`)

  const chunks = scanIslandChunks(entry)

  expect(chunks.size).toBe(1)
  expect([...chunks.values()]).toContain(dock)
})

test('two files sharing an island component name → two distinct content-addressed chunks', () => {
  // Same local name "Widget" from two different files, used by two pages. With
  // content-addressed ids this is no longer an error — each gets a distinct
  // `Widget_<hash>` chunk (the markers carry the same unique id).
  const widgetA = write('a/Widget.tsx', 'export default function Widget() { return null }\n')
  const widgetB = write('b/Widget.tsx', 'export default function Widget() { return null }\n')
  write(
    'PageA.tsx',
    `import Widget from './a/Widget'\n` +
      `export default function PageA() { return <Island component={Widget} props={{}} /> }\n`,
  )
  write(
    'PageB.tsx',
    `import Widget from './b/Widget'\n` +
      `export default function PageB() { return <Island component={Widget} props={{}} /> }\n`,
  )
  const entry = write(
    'routes.ts',
    `import PageA from './PageA'\nimport PageB from './PageB'\nexport default [PageA, PageB]\n`,
  )

  const chunks = scanIslandChunks(entry)
  expect(chunks.size).toBe(2)
  expect([...chunks.values()].sort()).toEqual([widgetA, widgetB].sort())
  for (const id of chunks.keys()) expect(id).toMatch(/^Widget_[a-f0-9]{8}$/)
})

// ── Task 2.8: extraIslands merge (md-route islands) ─────────────────────────

test('extraIslands: an md-only island is merged in by its content-addressed id', () => {
  const counter = write('Counter.tsx', 'export default function Counter() { return null }\n')
  const mdOnly = write('MdOnly.tsx', 'export default function MdOnly() { return null }\n')
  write(
    'Home.tsx',
    `import Counter from './Counter'\n` +
      `export default function Home() { return <Island component={Counter} props={{}} /> }\n`,
  )
  const entry = write('routes.ts', `import Home from './Home'\nexport default [Home]\n`)

  const chunks = scanIslandChunks(entry, new Map([['MdOnly', mdOnly]]))

  expect(chunks.size).toBe(2)
  expect([...chunks.values()]).toContain(counter)
  expect([...chunks.values()]).toContain(mdOnly)
  // Keyed by the SAME content-addressed scheme the md emit writes into markers.
  expect([...chunks.keys()].find((k) => k.startsWith('MdOnly_'))).toMatch(/^MdOnly_[a-f0-9]{8}$/)
})

test('extraIslands: same name + same source as a routes-graph island dedups (one chunk)', () => {
  const counter = write('Counter.tsx', 'export default function Counter() { return null }\n')
  write(
    'Home.tsx',
    `import Counter from './Counter'\n` +
      `export default function Home() { return <Island component={Counter} props={{}} /> }\n`,
  )
  const entry = write('routes.ts', `import Home from './Home'\nexport default [Home]\n`)

  const chunks = scanIslandChunks(entry, new Map([['Counter', counter]]))

  expect(chunks.size).toBe(1)
  expect([...chunks.values()]).toEqual([counter])
})

test('extraIslands: same name from a DIFFERENT file → two distinct content-addressed chunks', () => {
  // Mirrors the shipped same-name parity for routes-graph islands: distinct ids
  // never collide, so both chunks build and each marker resolves its own.
  const widgetA = write('a/Widget.tsx', 'export default function Widget() { return null }\n')
  const widgetB = write('b/Widget.tsx', 'export default function Widget() { return null }\n')
  write(
    'Home.tsx',
    `import Widget from './a/Widget'\n` +
      `export default function Home() { return <Island component={Widget} props={{}} /> }\n`,
  )
  const entry = write('routes.ts', `import Home from './Home'\nexport default [Home]\n`)

  const chunks = scanIslandChunks(entry, new Map([['Widget', widgetB]]))

  expect(chunks.size).toBe(2)
  expect([...chunks.values()].sort()).toEqual([widgetA, widgetB].sort())
})

test('extraIslands: undefined/empty leaves the scan result unchanged', () => {
  write('Counter.tsx', 'export default function Counter() { return null }\n')
  write(
    'Home.tsx',
    `import Counter from './Counter'\n` +
      `export default function Home() { return <Island component={Counter} props={{}} /> }\n`,
  )
  const entry = write('routes.ts', `import Home from './Home'\nexport default [Home]\n`)

  expect(scanIslandChunks(entry)).toEqual(scanIslandChunks(entry, new Map()))
})

test('throws naming the page for an <Island> with no component prop (loud miss)', () => {
  write('Bad.tsx', `export default function Bad() { return <Island props={{ x: 1 }} /> }\n`)
  const entry = write('routes.ts', `import Bad from './Bad'\nexport default [Bad]\n`)

  const badPath = resolve(dir, 'Bad.tsx')
  expect(() => scanIslandChunks(entry)).toThrow(badPath)
})

test('throws when the island component ident has no matching import', () => {
  // <Island component={Ghost}> but the page never imports Ghost.
  write(
    'Ghosty.tsx',
    `export default function Ghosty() { return <Island component={Ghost} props={{}} /> }\n`,
  )
  const entry = write('routes.ts', `import Ghosty from './Ghosty'\nexport default [Ghosty]\n`)

  expect(() => scanIslandChunks(entry)).toThrow('Ghost')
})

test('does not match an <Island> mentioned in a comment before a self-closing tag', () => {
  // Regression: the scanner regex must not bridge a comment's `<Island>` (no
  // `component=`) across an unrelated self-closing tag to a later `/>`. Such a
  // span has no `component=` and used to throw a false "no component prop".
  const counter = write('Counter.tsx', 'export default function Counter() { return null }\n')
  write('Card.tsx', 'export default function Card() { return null }\n')
  write(
    'Commented.tsx',
    `import Counter from './Counter'\n` +
      `import Card from './Card'\n` +
      `/** The native compiler emits host elements + \`<Island>\`. Shell is HTML. */\n` +
      `export default function Commented() {\n` +
      `  return (<div>\n` +
      `    <Card />\n` +
      `    <Island component={Counter} props={{ n: 1 }} />\n` +
      `  </div>)\n` +
      `}\n`,
  )
  const entry = write(
    'routes.ts',
    `import Commented from './Commented'\nexport default [Commented]\n`,
  )

  // Must NOT throw, and must find exactly the one real Island (Counter).
  const chunks = scanIslandChunks(entry)
  expect(chunks.size).toBe(1)
  expect([...chunks.values()]).toContain(counter)
  // Card is a plain element here, not an island — not a chunk.
  expect([...chunks.values()]).not.toContain(resolve(dir, 'Card.tsx'))
})

// buildIslands(new Map(), {outDir}) smoke: asserts the 3 unconditional runtime
// chunks land and islandCount === 0. Runs Bun.build 3× (react/react-dom/
// bootstrap); kept because it is the cheap zero-island path and guards the
// "always emit runtime" invariant.
test('buildIslands(empty) emits the 3 runtime chunks and islandCount 0', async () => {
  const { buildIslands } = await import('./build.ts')
  const outDir = mkdtempSync(resolve(tmpdir(), 'brust-build-'))
  try {
    const res = await buildIslands(new Map(), { outDir })
    expect(res.islandCount).toBe(0)
    expect(res.outDir).toBe(outDir)
    for (const f of ['_react.js', '_react-dom.js', '_bootstrap.js']) {
      expect(await Bun.file(resolve(outDir, f)).exists()).toBe(true)
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// Regression: `export *` from react omits the default per spec, so the
// importmap-targeted `_react.js` had named exports but NO default. Third-party
// ESM that does `import React from 'react'` (e.g. @dnd-kit) then failed to
// hydrate with "module 'react' does not provide an export named 'default'".
test('_react.js exposes a working default export AND keeps its named exports', async () => {
  const { buildIslands } = await import('./build.ts')
  const outDir = mkdtempSync(resolve(tmpdir(), 'brust-react-shim-'))
  try {
    await buildIslands(new Map(), { outDir })
    const mod = await import(resolve(outDir, '_react.js'))
    // Default = the React object: carries createElement/useState as members,
    // which is what `import React from 'react'; React.createElement(...)` needs.
    expect(typeof mod.default).toBe('object')
    expect(typeof mod.default.createElement).toBe('function')
    expect(typeof mod.default.useState).toBe('function')
    // Named exports unchanged (no regression on the hooks islands already use).
    expect(typeof mod.createElement).toBe('function')
    expect(typeof mod.useState).toBe('function')
    expect(typeof mod.useSyncExternalStore).toBe('function')
    // jsx-runtime exports (importmap maps react/jsx-runtime to the same chunk).
    expect(typeof mod.jsx).toBe('function')
    expect(typeof mod.jsxs).toBe('function')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// _react-dom.js has `react` external (importmap-resolved in the browser), so it
// can't be imported standalone in Node. Assert its emitted export list
// statically instead: createRoot + hydrateRoot (the named exports island
// hydration and the bootstrap depend on) MUST survive, and a `default` (the
// react-dom/client namespace) is present for `import ReactDOM from
// 'react-dom/client'` parity.
test('_react-dom.js export list keeps createRoot/hydrateRoot and adds a default', async () => {
  const { buildIslands } = await import('./build.ts')
  const outDir = mkdtempSync(resolve(tmpdir(), 'brust-reactdom-default-'))
  try {
    await buildIslands(new Map(), { outDir })
    const src = await Bun.file(resolve(outDir, '_react-dom.js')).text()
    const exportStmts = (src.match(/export\s*\{[^}]*\}/g) ?? []).join()
    expect(exportStmts).toContain('createRoot')
    expect(exportStmts).toContain('hydrateRoot')
    expect(exportStmts).toContain('default')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
