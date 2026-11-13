// F550 (security): compileComponent never runs code of the source. A Bun macro import (`with { type: "macro" }`) runs
// when the source is scanned or bundled with Bun's defaults; every Transpiler and Bun.build on the compile path disables
// macros, and a macro import is refused (`runtime-macro`) before the compiler and any bundle. Each case's macro would
// create a directory: it must not exist afterwards.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { compileComponent } from '../src/compile'
import { bundleClient } from '../src/compile/client'

const FX = join(import.meta.dir, 'fixtures')
const app = join(FX, `.tmp-no-macros-${process.pid}`)
const marks = mkdtempSync(join(tmpdir(), 'brust-no-macros-'))
let dist = ''

beforeAll(async () => {
  cpSync(join(FX, 'expose'), app, { recursive: true })
  // An app file a source could name as a macro module.
  writeFileSync(join(app, 'm.ts'), `import { mkdirSync } from 'node:fs'\nexport function mk(p: string) { mkdirSync(p); return 1 }\nexport default function mkd(p: string) { mkdirSync(p); return 1 }\n`)
  dist = mkdtempSync(join(tmpdir(), 'brust-no-macros-dist-'))
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {} })
}, 120_000)

afterAll(() => {
  for (const d of [app, dist, marks]) rmSync(d, { recursive: true, force: true })
})

const compile = (source: string, name = 'Evil') => compileComponent({ source, filename: `el/${name}.tsx`, appRoot: app, dist })
const rules = (r: Awaited<ReturnType<typeof compile>>) => (r.ok ? [] : r.diagnostics.filter((d) => d.class === 'error').map((d) => d.rule))

test('a builtin macro import (the repro) is refused and runs nothing', async () => {
  const mark = join(marks, 'builtin')
  const r = await compile(`import { mkdirSync } from "node:fs" with { type: "macro" };\nmkdirSync(${JSON.stringify(mark)});\nexport default function C() { return <b>x</b> }\n`)
  expect(r.ok).toBe(false)
  expect(rules(r)).toEqual(['runtime-macro'])
  expect(r.ok ? undefined : r.diagnostics[0]).toMatchObject({ line: 1, col: 37 })
  expect(existsSync(mark)).toBe(false)
})

test('a macro import of an app file, named or default, is refused and runs nothing', async () => {
  const named = join(marks, 'named')
  const dflt = join(marks, 'default')
  const a = await compile(`import { mk } from '../m.ts' with { type: 'macro' }\nconst x = mk(${JSON.stringify(named)})\nexport default function C() { return <b>{x}</b> }\n`)
  const b = await compile(`import mkd from '../m.ts' with { type: 'macro' }\nconst x = mkd(${JSON.stringify(dflt)})\nexport default function C() { return <b>{x}</b> }\n`)
  expect(rules(a)).toEqual(['runtime-macro'])
  expect(rules(b)).toEqual(['runtime-macro'])
  expect(existsSync(named)).toBe(false)
  expect(existsSync(dflt)).toBe(false)
})

test('any other import attribute is a runtime-import refusal', async () => {
  writeFileSync(join(app, 'data.json'), '{"a":1}')
  const r = await compile(`import data from '../data.json' with { type: 'json' }\nexport default function C() { return <b>{String(data.a)}</b> }\n`)
  expect(rules(r)).toContain('runtime-import')
  expect(r.ok ? '' : r.diagnostics.find((d) => d.rule === 'runtime-import' && /import attribute/.test(d.message))?.message).toContain('"../data.json"')
})

test('an ordinary component still compiles', async () => {
  const r = await compile(`export default function C({ label }: { label: string }) { return <b>{label}</b> }\n`, 'Plain')
  expect(r.ok).toBe(true)
})

test('the client bundle never runs a macro either (Bun.build macros: false)', async () => {
  const mark = join(marks, 'bundle')
  const tree = [{ source: 'el/C.tsx', clientJs: `import { mkdirSync } from "node:fs" with { type: "macro" };\nmkdirSync(${JSON.stringify(mark)});\nexport const x = 1\n` }]
  const r = await bundleClient(tree as never, { base: '', runtimeUrl: '/_brust/rt.js', storeUrl: '/_brust/st.js', exposed: {} }, { appRoot: app, filename: 'el/C.tsx' })
  expect(r.code).toBeNull()
  expect(r.problems.map((p) => p.message).join(' ')).toContain('Macros are disabled')
  expect(existsSync(mark)).toBe(false)
})

test('a re-export with a macro attribute is refused and runs nothing', async () => {
  const mark = join(marks, 'reexport')
  const r = await compile(
    `export { mk } from '../m.ts' with { type: 'macro' }\nimport { mk as run } from '../m.ts' with { type: 'macro' }\nconst x = run(${JSON.stringify(mark)})\nexport default function C() { return <b>{x}</b> }\n`,
  )
  expect(rules(r)).toEqual(['runtime-macro'])
  expect(existsSync(mark)).toBe(false)
  // the re-export alone (nothing calls it): refused the same way
  const only = await compile(`export { mk } from '../m.ts' with { type: 'macro' }\nexport default function C() { return <b>x</b> }\n`)
  expect(rules(only)).toEqual(['runtime-macro'])
})

test('a dynamic import() with attributes is refused and runs nothing', async () => {
  const mark = join(marks, 'dynamic')
  for (const attrs of [`{ with: { type: 'macro' } }`, `{ with: { type: 'json' } }`, `{ assert: { type: 'macro' } }`]) {
    const r = await compile(
      `export default function C() { return <b onClick={async () => { const m = await import('../m.ts', ${attrs}); m.mk(${JSON.stringify(mark)}) }}>x</b> }\n`,
    )
    expect(r.ok).toBe(false)
    expect(rules(r)).toContain('runtime-import')
    expect(existsSync(mark)).toBe(false)
  }
})

/** Every .ts file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}

test('guard: every Bun.Transpiler and Bun.build under src/compile (recursively) disables macros', () => {
  const files = tsFiles(join(import.meta.dir, '../src/compile'))
  expect(files.length).toBeGreaterThan(0)
  let transpilers = 0
  let builds = 0
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/new Bun\.Transpiler\(([^)]*)\)/g)) {
      transpilers++
      expect(`${f}: ${m[1]}`).toContain('macro: false')
    }
    // every call, whatever its argument looks like (an object literal, a variable, a spread)
    for (const m of text.matchAll(/Bun\.build\(/g)) {
      builds++
      expect(`${f}: ${text.slice(m.index!, m.index! + 400)}`).toContain('macros: false')
    }
  }
  expect(transpilers).toBeGreaterThanOrEqual(2)
  expect(builds).toBeGreaterThanOrEqual(1)
})
