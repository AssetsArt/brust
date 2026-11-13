// F549 `[build] expose_isolated`: the exposed entries are built first in their own bundle and a built component imports them
// by URL. Without it (the default) a module both the component and an exposed module import is hoisted into a shared
// `chunk-*` and the component's own chunk shrinks to a stub; with it the component keeps its own copy, there is no shared
// chunk, and the exposed module is still ONE file everyone imports. The served proof (one instance of the exposed module
// in a browser) is tests/server/expose-isolated.chromium.test.ts.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { loadBuildConfig, parseExposeIsolated } from '../src/build/config'

const FX = join(import.meta.dir, 'fixtures')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'brust-expose-iso-'))
  made.push(d)
  return d
}

/** A copy of the fixture app inside the fixtures directory (so `@brust/core` resolves), with `files` written over it (null = removed). */
let n = 0
function variant(files: Record<string, string | null>): string {
  const dir = join(FX, `.tmp-expose-iso-${process.pid}-${n++}`)
  made.push(dir)
  cpSync(join(FX, 'expose-isolated'), dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, f), { force: true })
    else {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), text)
    }
  }
  return dir
}

const toml = (isolated: boolean | string | null) => `[build]\nexpose = ["shop/sdk.ts"]\n${isolated === null ? '' : `expose_isolated = ${isolated}\n`}`

const build = async (app: string) => {
  const out = tmp()
  const logs: string[] = []
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: out, log: (l) => logs.push(l) })
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  const files = readdirSync(join(out, 'client')).map((f) => ({ f, text: readFileSync(join(out, 'client', f), 'utf8') }))
  const comp = Object.values(manifest.components as Record<string, { client: string | null }>).find((c) => c.client !== null)!
  return { out, logs, manifest, files, counter: readFileSync(join(out, comp.client!), 'utf8'), counterFile: comp.client!.replace(/^client\//, '') }
}
const holders = (files: { f: string; text: string }[], needle: string) => files.filter(({ text }) => text.includes(needle)).map(({ f }) => f)

test('today (flag off): the module both sides import is hoisted into one shared chunk and the component chunk is a stub', async () => {
  const r = await build(variant({ 'brust.toml': toml(false) }))
  const heavy = holders(r.files, 'heavy-marker-')
  expect(heavy).toHaveLength(1)
  expect(heavy[0]).toMatch(/^chunk-/)
  expect(r.counter).not.toContain('heavy-marker-')
  expect(r.counter).toContain(`./${heavy[0]}`)
  // ...and the same when the key is absent.
  const absent = await build(variant({ 'brust.toml': toml(null) }))
  expect(holders(absent.files, 'heavy-marker-')[0]).toMatch(/^chunk-/)
})

test('flag on: the component chunk carries its own copy, no shared chunk exists, and it imports the exposed entry by URL', async () => {
  const r = await build(variant({ 'brust.toml': toml(true) }))
  const sdk = r.manifest.runtime.exposed['shop/sdk.ts'] as string
  expect(sdk).toMatch(/^client\/x-sdk-[0-9a-f]{10}\.js$/)
  expect(r.counter).toContain('heavy-marker-')
  expect(r.files.filter(({ f }) => f.startsWith('chunk-'))).toEqual([])
  // The exposed entry holds its own copy of `lib/heavy` too (the price); both are whole files, neither a shared chunk.
  expect(holders(r.files, 'heavy-marker-').sort()).toEqual([r.counterFile, sdk.replace(/^client\//, '')].sort())
  expect(r.counter).toContain(`/_brust/${sdk}`)
  // The component does not carry the exposed module: its body lives only in the exposed entry.
  expect(holders(r.files, '__shopSdkLoads')).toEqual([sdk.replace(/^client\//, '')])
  expect(r.counter).not.toContain('__shopSdkLoads')
})

test('R1.3/R1.4 hold with the flag on: the manifest names the same exposed file and stores, and jobs.js touches the store module', async () => {
  const off = await build(variant({ 'brust.toml': toml(false) }))
  const on = await build(variant({ 'brust.toml': toml(true) }))
  expect(Object.keys(on.manifest.runtime.exposed)).toEqual(Object.keys(off.manifest.runtime.exposed))
  expect(on.manifest.runtime.stores).toEqual({ cart: 'shop/sdk.ts' })
  expect(on.manifest.runtime.stores).toEqual(off.manifest.runtime.stores)
  expect(readFileSync(join(on.out, 'jobs.js'), 'utf8')).toContain('"shop/sdk.ts"')
  // The entry keeps every export of the source module under its source name.
  const entry = readFileSync(join(on.out, on.manifest.runtime.exposed['shop/sdk.ts']), 'utf8')
  const names = /export\{([^}]*)\}/.exec(entry)![1]!.split(',').map((p) => p.split(' as ').pop()!.trim())
  expect(names.sort()).toEqual(['bump', 'cart', 'count', 'default', 'instance', 'label'])
})

test('flag on with no shared dependency changes nothing for the component, and with no `expose` it has no effect', async () => {
  const lone = await build(variant({ 'brust.toml': toml(true), 'lib/heavy.ts': null, 'shop/sdk.ts': "export const count = 1\nexport const bump = () => 1\nexport const cart = { count: () => 0 }\nexport const label = () => ''\nexport const instance = 1\nexport default 1\n", 'Counter.tsx': "import { useState } from 'react'\nimport { bump } from './shop/sdk'\nexport default function Counter() {\n  const [n, setN] = useState(0)\n  return (\n    <button type=\"button\" data-testid=\"b\" onClick={() => { setN(n + 1); bump() }}>\n      native {n}\n    </button>\n  )\n}\n" }))
  expect(lone.files.filter(({ f }) => f.startsWith('chunk-'))).toEqual([])
  expect(lone.counter).toContain(`/_brust/${lone.manifest.runtime.exposed['shop/sdk.ts']}`)
  const noExpose = await build(variant({ 'brust.toml': '[build]\nexpose_isolated = true\n' }))
  const plain = await build(variant({ 'brust.toml': null }))
  expect(noExpose.manifest.runtime).toBeUndefined()
  expect(noExpose.manifest.assets.build).toBe(plain.manifest.assets.build)
})

test('two exposed modules that share a dependency keep one instance of it between them (splitting stays inside the exposed build)', async () => {
  const app = variant({
    'brust.toml': '[build]\nexpose = ["shop/sdk.ts", "shop/wish.ts"]\nexpose_isolated = true\n',
    'shop/wish.ts': "import { heavy } from '../lib/heavy'\nexport const wish = () => heavy(1)\n",
  })
  const r = await build(app)
  const [a, b] = ['shop/sdk.ts', 'shop/wish.ts'].map((k) => (r.manifest.runtime.exposed[k] as string).replace(/^client\//, ''))
  expect(a).not.toBe(b)
  // `lib/heavy` is in one chunk the two exposed entries share, and the component keeps its own copy.
  const shared = holders(r.files, 'heavy-marker-').filter((f) => f.startsWith('chunk-'))
  expect(shared).toHaveLength(1)
  expect(r.files.find(({ f }) => f === a)!.text).toContain(`./${shared[0]}`)
  expect(r.files.find(({ f }) => f === b)!.text).toContain(`./${shared[0]}`)
  expect(r.counter).toContain('heavy-marker-')
})

test('expose_isolated must be a boolean', async () => {
  expect(parseExposeIsolated('brust.toml', undefined)).toBe(false)
  expect(parseExposeIsolated('brust.toml', true)).toBe(true)
  for (const v of ['true', 1, ['x']]) expect(() => parseExposeIsolated('brust.toml', v)).toThrow(/build\.expose_isolated must be true or false/)
  const app = variant({ 'brust.toml': toml('"yes"') })
  await expect(loadBuildConfig(app)).rejects.toMatchObject({ rule: 'config', message: expect.stringMatching(/build\.expose_isolated must be true or false/) })
  expect((await loadBuildConfig(variant({ 'brust.toml': toml(true) }))).exposeIsolated).toBe(true)
  expect((await loadBuildConfig(variant({ 'brust.toml': toml(null) }))).exposeIsolated).toBe(false)
})

const warnings = (logs: string[], rule: string) => logs.filter((l) => l.startsWith(`[brust] warning ${rule} `))

test('flag on: ONE warning names each module bundled into both builds (a copy in the browser); flag off and no overlap say nothing', async () => {
  const on = await build(variant({ 'brust.toml': toml(true) }))
  const w = warnings(on.logs, 'expose-isolated-duplicate')
  expect(w).toHaveLength(1)
  expect(w[0]).toContain('lib/heavy.ts')
  expect(w[0]).not.toContain('shop/sdk.ts') // the exposed module itself is only in the exposed build
  expect(w[0]).toMatch(/two copies .*must be reached through an exposed module/)
  expect(on.logs.filter((l) => /error/i.test(l))).toEqual([]) // a warning, never an error
  expect(warnings((await build(variant({ 'brust.toml': toml(false) }))).logs, 'expose-isolated-duplicate')).toEqual([])
  const lone = await build(
    variant({
      'brust.toml': toml(true),
      'lib/heavy.ts': null,
      'shop/sdk.ts': 'export const count = 1\nexport const bump = () => 1\nexport const cart = { count: () => 0 }\nexport const label = () => ""\nexport const instance = 1\nexport default 1\n',
      'Counter.tsx': "import { useState } from 'react'\nimport { bump } from './shop/sdk'\nexport default function Counter() {\n  const [n, setN] = useState(0)\n  return <button type=\"button\" onClick={() => { setN(n + 1); bump() }}>native {n}</button>\n}\n",
    }),
  )
  expect(warnings(lone.logs, 'expose-isolated-duplicate')).toEqual([])
})

test('a package both builds bundle is named by its package (not a path), and brust\'s own packages are not listed', async () => {
  const dir = variant({ 'brust.toml': toml(true) })
  // A tiny package in the app\'s node_modules that the component and the exposed module both import.
  mkdirSync(join(dir, 'node_modules/dupe-pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/dupe-pkg/package.json'), '{"name":"dupe-pkg","version":"1.0.0","main":"index.js"}')
  writeFileSync(join(dir, 'node_modules/dupe-pkg/index.js'), 'exports.dupe = (n) => "dupe-pkg-marker-" + n\n')
  writeFileSync(join(dir, 'lib/heavy.ts'), "import { dupe } from 'dupe-pkg'\nexport const HEAVY = 'heavy-marker-'\nexport const heavy = (n: number) => dupe(n) + HEAVY\n")
  const w = warnings((await build(dir)).logs, 'expose-isolated-duplicate')
  expect(w).toHaveLength(1)
  expect(w[0]).toContain('dupe-pkg')
  expect(w[0]).not.toContain('node_modules')
  expect(w[0]).not.toContain('@brust/')
})

test('expose_isolated = true with no `expose` is a build WARNING (not an error, not silent); with `expose` there is none', async () => {
  const none = await build(variant({ 'brust.toml': '[build]\nexpose_isolated = true\n' }))
  const w = warnings(none.logs, 'expose-isolated-no-expose')
  expect(w).toHaveLength(1)
  expect(w[0]).toContain('expose_isolated')
  expect(w[0]).toContain('no effect')
  expect(warnings((await build(variant({ 'brust.toml': toml(true) }))).logs, 'expose-isolated-no-expose')).toEqual([])
  expect(warnings((await build(variant({ 'brust.toml': toml(false) }))).logs, 'expose-isolated-no-expose')).toEqual([])
})

// F362 PR2 (projected lists) with the flag on: the module-projection fixture, with `reader.ts` exposed. `reader.ts` is the
// second importer of `data_shared.ts`, so the probe sees that data module in the client graph (through the exposed entry)
// and `p_shared` imports its list as written; `data.ts` has no other importer, so `p_import` keeps its list projected.
test('projection fallbacks stay correct with the flag on: a list the exposed side also loads is imported as written, an unshared one stays projected', async () => {
  const dir = join(FX, `.tmp-expose-iso-proj-${process.pid}`)
  made.push(dir)
  cpSync(join(FX, 'module-projection'), dir, { recursive: true })
  const run = async (isolated: boolean) => {
    writeFileSync(join(dir, 'brust.toml'), `[build]\nexpose = ["reader.ts"]\nexpose_isolated = ${isolated}\n`)
    return build(dir)
  }
  const chunkOf = (r: Awaited<ReturnType<typeof build>>, id: string) => {
    const c = Object.entries(r.manifest.components as Record<string, { client: string | null }>).find(([k, v]) => k.startsWith(`${id}_`) && v.client !== null)
    return readFileSync(join(r.out, c![1].client!), 'utf8')
  }
  for (const isolated of [false, true]) {
    const r = await run(isolated)
    const secret = holders(r.files, 'SECRET_A')
    const shared = chunkOf(r, 'pShared')
    // The list a second loader (the exposed `reader.ts`) holds reaches the page as written: in `pShared`'s own chunk when
    // isolated (its copy), in the one chunk it shares with the exposed entry otherwise.
    expect(secret.length > 0 && (shared.includes('SECRET_A') || secret.some((f) => shared.includes(`./${f}`))), `isolated=${isolated}`).toBe(true)
    // An unshared list stays projected: neither its own text nor anything it imports carries the unread `secret`.
    for (const id of ['pImport', 'pRows']) {
      const text = chunkOf(r, id)
      expect(text, `isolated=${isolated} ${id}`).not.toContain('SECRET_A')
      expect(secret.some((f) => text.includes(`./${f}`)), `isolated=${isolated} ${id} imports a holder`).toBe(false)
    }
    // No page script carries the unread `other` export of the data module: it is in no client graph at all.
    expect(r.files.filter(({ text }) => text.includes('SECRET_OTHER'))).toEqual([])
  }
  const on = await run(true)
  // The price, named in the warning: the exposed `reader.ts` and `p_shared` each hold a copy of the data module.
  expect(warnings(on.logs, 'expose-isolated-duplicate')[0]).toContain('data_shared.ts')
  expect(chunkOf(on, 'pShared')).toContain('SECRET_A')
  expect(holders(on.files, 'SECRET_A')).toContain((on.manifest.runtime.exposed['reader.ts'] as string).replace(/^client\//, ''))
})

// F548 + F549 together: `[build] islands` (an exposed React component built as an island no route renders, placed client-only
// by a runtime component) with `expose_isolated = true`. The island's own chunk and manifest entry are the same as without the
// flag, the exposed module is still its own `x-` entry, and `compileComponent` still places the island.
test('[build] islands and expose_isolated work together: the listed island keeps its chunk and manifest entry, and a runtime component places it', async () => {
  const { compileComponent } = await import('../src/compile')
  const build2 = async (isolated: boolean) => {
    const dir = join(FX, `.tmp-expose-iso-islands-${process.pid}-${isolated}`)
    made.push(dir)
    cpSync(join(FX, 'rc-client-islands'), dir, { recursive: true, filter: (p) => !p.includes('/dist') && !p.includes('/.brust') })
    writeFileSync(join(dir, 'brust.toml'), `[build]\nexpose = ["shop/sdk.tsx"]\nislands = ["shop/sdk.tsx#Motion"]\nexpose_isolated = ${isolated}\n`)
    const out = tmp()
    const logs: string[] = []
    await runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: out, log: (l) => logs.push(l), force: true })
    return { dir, out, logs, manifest: JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) }
  }
  const off = await build2(false)
  const on = await build2(true)
  const id = Object.keys(on.manifest.runtime.islands)[0]!
  expect(id).toMatch(/^motion_[0-9a-f]{8}$/)
  // the same manifest entries as without the flag: the island id, its `path#Export`, its React tier and chunk
  expect(on.manifest.runtime.islands).toEqual(off.manifest.runtime.islands)
  expect(on.manifest.components[id].tier).toBe('react')
  expect(on.manifest.components[id].client).toMatch(new RegExp(`^client/react-${id}-[0-9a-f]+\\.js$`))
  const chunk = readFileSync(join(on.out, on.manifest.components[id].client), 'utf8')
  expect(chunk).toContain('data-testid') // the island's own code is in its chunk
  expect(readFileSync(join(on.out, 'jobs.js'), 'utf8')).not.toContain(id)
  // the exposed module is still one `x-` entry, built apart
  expect(on.manifest.runtime.exposed['shop/sdk.tsx']).toMatch(/^client\/x-sdk-[0-9a-f]{10}\.js$/)
  expect(on.logs.filter((l) => /error/i.test(l))).toEqual([])
  // a runtime component placing the island still compiles against this build, to a client-only host in `artifact.islands`
  const promo = "import { Motion } from '../shop/sdk'\nexport default function Promo({ label }: { label: string }) {\n  return <section><h3>{label}</h3><Motion label={label} /></section>\n}\n"
  const r = await compileComponent({ source: promo, filename: 'el/Promo.tsx', appRoot: on.dir, dist: on.out })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  expect(r.artifact.islands).toEqual([id])
  expect(r.artifact.features).toContain('island')
  expect(r.artifact.jinja).toContain(`data-id="${id}"`)
}, 180_000)
