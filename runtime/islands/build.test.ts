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
  expect(chunks.get('Counter')).toBe(counter)
  expect(chunks.get('Clock')).toBe(clock)
})

test('throws naming both paths when two files share an island component name', () => {
  // Two distinct component files, same local name "Widget", imported by two
  // different pages → app-uniqueness violation.
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

  expect(() => scanIslandChunks(entry)).toThrow(widgetA)
  expect(() => scanIslandChunks(entry)).toThrow(widgetB)
})

test('throws naming the page for an <Island> with no component prop (loud miss)', () => {
  write(
    'Bad.tsx',
    `export default function Bad() { return <Island props={{ x: 1 }} /> }\n`,
  )
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
