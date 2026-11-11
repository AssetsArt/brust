// F518 `@brust/core/compile`: `compileComponent(source)` against a real `dist/` of an app that exposes modules (F517).
// One variant app is built once; every case compiles a source string against that build. R3.7: each refusal, the id, and the
// store-reading list component whose chunk imports only the runtime, the store module and an exposed module.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { MAX_JINJA_BYTES, type CompileResult, compileComponent, virtualPath } from '../src/compile'

const FX = join(import.meta.dir, 'fixtures')
const made: string[] = []
let app = ''
let dist = ''
let manifest: { assets: { build: string; runtime: string; features: Record<string, string> }; runtime: { exposed: Record<string, string>; stores: Record<string, string> } }

beforeAll(async () => {
  app = join(FX, `.tmp-compile-${process.pid}`)
  made.push(app)
  cpSync(join(FX, 'expose'), app, { recursive: true })
  mkdirSync(join(app, 'ui'))
  writeFileSync(join(app, 'ui/Field.tsx'), "import { useId } from 'react'\nexport default function Field({ label }: { label: string }) {\n  const id = useId()\n  return <label htmlFor={id}>{label}<input id={id} /></label>\n}\n")
  writeFileSync(join(app, 'ui/Tag.tsx'), "import { useState } from 'react'\nexport default function Tag({ label }: { label: string }) {\n  const [n, setN] = useState(0)\n  return <i onClick={() => setN(n + 1)}>{label}{n}</i>\n}\n")
  writeFileSync(join(app, 'ui/Fmt.tsx'), "export default function Fmt({ v }: { v: string }) {\n  return <u>{v.toUpperCase().padStart(6, '.')}</u>\n}\n")
  writeFileSync(join(app, 'brust.toml'), '[build]\nexpose = ["shop/sdk.ts", "shop/wish.ts", "ui/Field.tsx", "ui/Tag.tsx", "ui/Fmt.tsx"]\n')
  dist = mkdtempSync(join(tmpdir(), 'brust-compile-dist-'))
  made.push(dist)
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {} })
  manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
}, 120_000)

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const compile = (source: string, filename = 'el/Promo.tsx'): Promise<CompileResult> => compileComponent({ source, filename, appRoot: app, dist })
const rules = (r: CompileResult) => r.diagnostics.filter((d) => d.class === 'error').map((d) => d.rule)
const ok = (r: CompileResult) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.diagnostics)}`)
  return r.artifact
}

const LIST = `import { useStore } from '@brust/core/store/react'
import { cart } from '../shop/sdk'
export default function Promo({ items }: { items: string[] }) {
  const c = useStore(cart)
  return <ul>{items.map((i) => <li key={i}>{i} {c.count}</li>)}<button onClick={() => cart.count.set(c.count + 1)}>add</button></ul>
}
`

test('R3.7: a store-reading list component compiles native and its chunk imports only the runtime, the store module and an exposed module', async () => {
  const a = ok(await compile(LIST))
  expect(a).toMatchObject({ v: 1, tier: 'native', stores: ['cart'], build: manifest.assets.build })
  expect(a.id).toMatch(/^promo[A-Za-z0-9]{16}_[0-9a-f]{8}$/)
  expect(a.features).toEqual(expect.arrayContaining(['basics', 'for', 'store']))
  expect(a.jinja).toContain(`x-data="${a.id}"`)
  expect(a.client).toContain(`("${a.id}",`) // defineBehavior(<id>, …): the identifier is minified, the id never
  // One self-contained module: its imports are all absolute URLs of the three kinds.
  const imports = [...a.client!.matchAll(/from"([^"]+)"/g)].map((m) => m[1]!)
  const runtime = `/_brust/${manifest.assets.runtime}`
  const sdk = `/_brust/${manifest.runtime.exposed['shop/sdk.ts']}`
  expect(imports.length).toBeGreaterThan(0)
  for (const u of imports) expect([runtime, `/_brust/${manifest.assets.features.store}`, sdk]).toContain(u)
  expect(imports).toContain(sdk)
  expect(JSON.parse(JSON.stringify(a))).toEqual(a) // JSON-serialisable
})

test('a static component has no client module and no features', async () => {
  const a = ok(await compile('export default function Promo({ label }: { label: string }) {\n  return <h1>{label}</h1>\n}\n'))
  expect(a).toMatchObject({ tier: 'static', client: null, features: [], stores: [] })
})

test('a static shell around a native child is a native artifact (one chunk carries the child)', async () => {
  const a = ok(await compile("import Tag from '../ui/Tag'\nexport default function Promo({ l }: { l: string }) {\n  return <div><Tag label={l} /></div>\n}\n"))
  expect(a.tier).toBe('native')
  expect(a.client).toMatch(/\w\("tag_[0-9a-f]{8}",/) // the child's behavior is in the one module
  expect(a.features).toContain('basics')
})

test('R3.3: the id is a function of (filename, source bytes), on its own content hash', async () => {
  const src = 'export default function Promo() {\n  return <p>one</p>\n}\n'
  const a = ok(await compile(src))
  expect(ok(await compile(src))).toEqual(a) // same input, same artifact
  expect(ok(await compile(`${src}\n`)).id).not.toBe(a.id) // one byte more: another id
  // Equal source under two filenames differ: the file name is part of the identity (it decides how imports resolve).
  expect(ok(await compile(src, 'other/Promo.tsx')).id).not.toBe(a.id)
  expect(virtualPath('el/Promo.tsx', src)).toMatch(/^el\/Promo-[0-9a-f]{16}\.tsx$/)
  expect(virtualPath('Promo.v2.tsx', src)).toMatch(/^Promo-[0-9a-f]{16}\.v2\.tsx$/)
})

test('R3.4 runtime-tier: a component that falls back to React is refused with the reason', async () => {
  const r = await compile("import { useDeferredValue } from 'react'\nexport default function Promo({ q }: { q: string }) {\n  const v = useDeferredValue(q)\n  return <p>{v}</p>\n}\n")
  expect(r.ok).toBe(false)
  expect(rules(r)).toContain('runtime-tier')
  expect(r.diagnostics.find((d) => d.rule === 'runtime-tier')!.message).toContain('useDeferredValue')
})

test('R3.4 runtime-jobs: a server job the component needs is refused and named', async () => {
  const r = await compile("export default function Promo({ items }: { items: string[] }) {\n  return <ul>{items.map((i) => <li key={i}>{i.toUpperCase().padStart(8, '*')}</li>)}</ul>\n}\n")
  expect(rules(r)).toContain('runtime-jobs')
  expect(r.diagnostics.find((d) => d.rule === 'runtime-jobs')!.message).toMatch(/precompute.*items/)
})

test('R3.4 runtime-import: an import that is not an exposed module is refused with its position', async () => {
  const r = await compile("import { x } from './nope'\nexport default function Promo() {\n  return <p>{x}</p>\n}\n")
  expect(r.ok).toBe(false)
  const d = r.diagnostics.find((d) => d.rule === 'runtime-import')!
  expect(d.message).toContain('"./nope"')
  expect([d.line, d.col]).toEqual([1, 19])
  // An exposed module and `react` are fine; a package is not.
  expect(rules(await compile("import _ from 'lodash'\nexport default function Promo() {\n  return <p>{_.x}</p>\n}\n"))).toContain('runtime-import')
  expect(rules(await compile("import { bump } from '../shop/sdk'\nimport { useState } from 'react'\nexport default function Promo() {\n  const [n, s] = useState(0)\n  return <b onClick={() => { s(n + 1); bump() }}>{n}</b>\n}\n"))).toEqual([])
})

test('R3.4 runtime-store: a store no exposed module defines is refused (with the import that carries it)', async () => {
  const r = await compile("import { useStore } from '@brust/core/store/react'\nimport { other } from '../shop/other'\nexport default function Promo() {\n  const c = useStore(other)\n  return <b>{c.count}</b>\n}\n")
  expect(rules(r)).toEqual(expect.arrayContaining(['runtime-import', 'runtime-store']))
  expect(r.diagnostics.find((d) => d.rule === 'runtime-store')!.message).toContain('"other"')
})

test('R3.4 runtime-use-id and runtime-children: useId, and a child the server would feed', async () => {
  expect(rules(await compile("import { useId } from 'react'\nexport default function Promo() {\n  const id = useId()\n  return <label htmlFor={id}>x<input id={id} /></label>\n}\n"))).toContain('runtime-use-id')
  const child = await compile("import Field from '../ui/Field'\nexport default function Promo({ l }: { l: string }) {\n  return <div><Field label={l} /></div>\n}\n")
  expect(rules(child)).toContain('runtime-children')
  const fed = await compile("import Fmt from '../ui/Fmt'\nexport default function Promo({ l }: { l: string }) {\n  return <div><Fmt v={l} /></div>\n}\n")
  expect(rules(fed)).toEqual(expect.arrayContaining(['runtime-children', 'runtime-jobs']))
})

test('R3.4 runtime-dynamic reads the compiler flag: a <Dynamic> is refused, markup that merely says brust_dynamic( is not', async () => {
  const slot = await compile("import { Dynamic } from '@brust/core'\nexport default function Promo({ r }: { r: string }) {\n  return <div><Dynamic component={r} props={{}} /></div>\n}\n")
  expect(slot.ok).toBe(false)
  expect(rules(slot)).toContain('runtime-dynamic')
  // The text a regex over the template would have refused.
  const text = ok(await compile("export default function Promo() {\n  return <code>{'{{ brust_dynamic(x, y) }}'} brust_dynamic(</code>\n}\n"))
  expect(text.jinja).toContain('brust_dynamic(')
})

test('R3.4 runtime-size: a template over the limit is refused', async () => {
  const big = 'x'.repeat(MAX_JINJA_BYTES + 10)
  const r = await compile(`export default function Promo() {\n  return <p>${big}</p>\n}\n`)
  expect(r.ok).toBe(false)
  expect(rules(r)).toEqual(['runtime-size'])
})

test('a source that does not parse is ok:false with the compiler error, naming the file given (not the hashed one)', async () => {
  const r = await compile('export default function Promo( { return <p></p> }\n')
  expect(r.ok).toBe(false)
  expect(rules(r)).toEqual(['parse'])
  expect(r.diagnostics[0]!.message).toContain('el/Promo.tsx')
  expect(r.diagnostics[0]!.message).not.toMatch(/Promo-[0-9a-f]{16}/)
})

test('nothing is written under the app root', async () => {
  const before = readdirTree(app)
  ok(await compile(LIST, 'el/Written.tsx'))
  expect(existsSync(join(app, 'el'))).toBe(false)
  expect(readdirTree(app)).toEqual(before)
})

const readdirTree = (dir: string): string[] => [...new Bun.Glob('**/*').scanSync({ cwd: dir, dot: true })].sort()

test('arguments and the build are checked up front', async () => {
  const bad = (filename: string) => compileComponent({ source: '', filename, appRoot: app, dist })
  await expect(bad('../x.tsx')).rejects.toThrow(/virtual app-root-relative/)
  await expect(bad('/abs/x.tsx')).rejects.toThrow(/virtual app-root-relative/)
  await expect(bad('el/x.ts')).rejects.toThrow(/\.tsx or \.jsx/)
  await expect(compileComponent({ source: 'x', filename: 'el/P.tsx', appRoot: app, dist: join(dist, 'nope') })).rejects.toThrow(/brust build/)
})

test('`@brust/core/compile` is refused in a browser bundle like `./native`', async () => {
  const out = mkdtempSync(join(tmpdir(), 'brust-compile-so-'))
  made.push(out)
  await expect(runBuild({ appRoot: join(FX, 'safety/so-compile'), entry: 'routes.tsx', outDir: out, log: () => {} })).rejects.toMatchObject({
    rule: 'server-only-in-client',
    message: expect.stringContaining('@brust/core/compile'),
  })
}, 60_000)
