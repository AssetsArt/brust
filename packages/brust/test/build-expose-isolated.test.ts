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
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: out, log: () => {} })
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  const files = readdirSync(join(out, 'client')).map((f) => ({ f, text: readFileSync(join(out, 'client', f), 'utf8') }))
  const comp = Object.values(manifest.components as Record<string, { client: string | null }>).find((c) => c.client !== null)!
  return { out, manifest, files, counter: readFileSync(join(out, comp.client!), 'utf8'), counterFile: comp.client!.replace(/^client\//, '') }
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
