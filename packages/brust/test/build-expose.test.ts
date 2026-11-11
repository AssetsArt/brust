// F517 `[build] expose`: app modules a runtime component (compiled after the build) imports. Each one is an entry of the
// native-chunk `Bun.build`, so a built component that imports it and the entry URL share ONE module instance; the manifest
// names them (`runtime.exposed`) and the stores they define (`runtime.stores`); `jobs.js` can touch those stores.
// The served proof that the instance is one in a browser is tests/server/expose.chromium.test.ts.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { loadBuildConfig, parseExpose } from '../src/build/config'
import { exposedModules, exposedStores, wrapperSource } from '../src/build/expose'

const FX = join(import.meta.dir, 'fixtures')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'brust-expose-'))
  made.push(d)
  return d
}

/** A copy of the fixture app inside the fixtures directory (so `@brust/core` resolves), with `files` written over it (null = removed). */
let n = 0
function variant(files: Record<string, string | null>): string {
  const dir = join(FX, `.tmp-expose-${process.pid}-${n++}`)
  made.push(dir)
  cpSync(join(FX, 'expose'), dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, f), { force: true })
    else {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), text)
    }
  }
  return dir
}

const build = async (app: string, entry = 'routes.tsx') => {
  const out = tmp()
  await runBuild({ appRoot: app, entry, outDir: out, log: () => {} })
  return { out, manifest: JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) }
}
const clientTexts = (out: string) => readdirSync(join(out, 'client')).map((f) => ({ f, text: readFileSync(join(out, 'client', f), 'utf8') }))

test('R1.2/R1.3: each exposed module is a hashed `x-<stem>` entry, and the manifest names it and its stores', async () => {
  const { out, manifest } = await build(join(FX, 'expose'))
  expect(manifest.runtime.exposed).toEqual({ 'shop/sdk.ts': expect.stringMatching(/^client\/x-sdk-[0-9a-f]{10}\.js$/), 'shop/wish.ts': expect.stringMatching(/^client\/x-wish-[0-9a-f]{10}\.js$/) })
  expect(manifest.runtime.stores).toEqual({ cart: 'shop/sdk.ts', wish: 'shop/wish.ts' })
  // The entry keeps every export of the source module under its source name (minify renames locals, never an entry's exports).
  const entry = readFileSync(join(out, manifest.runtime.exposed['shop/sdk.ts']), 'utf8')
  const names = /export\{([^}]*)\}/.exec(entry)![1]!.split(',').map((p) => p.split(' as ').pop()!.trim())
  expect(names.sort()).toEqual(['bump', 'cart', 'count', 'default', 'instance'])
})

test('R1.2: the module is in one file; the component chunk imports it instead of carrying a copy (one instance)', async () => {
  const { out, manifest } = await build(join(FX, 'expose'))
  const holders = clientTexts(out).filter(({ text }) => text.includes('__shopSdkLoads'))
  expect(holders).toHaveLength(1)
  // The holder is neither the entry nor the component chunk: both import it.
  const [holder] = holders
  expect(holder!.f).toMatch(/^chunk-/)
  const comp = Object.values(manifest.components as Record<string, { client: string | null }>).find((c) => c.client !== null)!
  expect(readFileSync(join(out, comp.client!), 'utf8')).toContain(`./${holder!.f}`)
  expect(readFileSync(join(out, manifest.runtime.exposed['shop/sdk.ts']), 'utf8')).toContain(`./${holder!.f}`)
})

test('R1.4: jobs.js stores table holds an exposed store module no built component reads', async () => {
  const { out } = await build(join(FX, 'expose'))
  const jobs = readFileSync(join(out, 'jobs.js'), 'utf8')
  expect(jobs).toContain('"shop/sdk.ts"')
  expect(jobs).toContain('"shop/wish.ts"') // nothing in the app imports it: only `expose` puts it here
})

test('without `expose` the manifest has no runtime block; adding it changes the build id (K5)', async () => {
  const plain = await build(variant({ 'brust.toml': null }))
  expect(plain.manifest.runtime).toBeUndefined()
  const exposed = await build(join(FX, 'expose'))
  expect(exposed.manifest.assets.build).not.toBe(plain.manifest.assets.build)
})

test('an app with no native chunk still emits the exposed entries', async () => {
  const app = variant({
    'routes.tsx': "import { defineRoutes } from '@brust/core/routes'\nimport Page from './Page'\nexport const routes = defineRoutes([{ path: '/', Component: Page }])\n",
    'Page.tsx': 'export default function Page() {\n  return <h1>static</h1>\n}\n',
    'Native.tsx': null,
    'brust.toml': '[build]\nexpose = ["shop/wish.ts"]\n',
  })
  const { out, manifest } = await build(app)
  expect(Object.values(manifest.components as Record<string, { client: string | null }>).every((c) => c.client === null)).toBe(true)
  expect(manifest.runtime.exposed['shop/wish.ts']).toMatch(/^client\/x-wish-[0-9a-f]{10}\.js$/)
  expect(readFileSync(join(out, manifest.runtime.exposed['shop/wish.ts']), 'utf8')).toContain('wish')
  expect(manifest.runtime.stores).toEqual({ wish: 'shop/wish.ts' })
})

test('R1.1: a bad entry is a BuildError naming it', async () => {
  const toml = (expose: string) => `[build]\nexpose = ${expose}\n`
  const refused = async (files: Record<string, string | null>, why: RegExp) => {
    await expect(build(variant(files))).rejects.toMatchObject({ rule: expect.stringMatching(/^(config|expose-not-module)$/), message: expect.stringMatching(why) })
  }
  await refused({ 'brust.toml': toml('["shop/missing.ts"]') }, /shop\/missing\.ts.*not an existing file/)
  await refused({ 'brust.toml': toml('["../../../../../package.json"]') }, /outside the app root and every build\.source_roots/)
  await refused({ 'notes.md': '# hi\n', 'brust.toml': toml('["notes.md"]') }, /not a JavaScript or TypeScript module/)
  await refused({ 'shop/none.ts': 'const x = 1\n', 'brust.toml': toml('["shop/none.ts"]') }, /has no export/)
  await refused({ 'brust.toml': '[build]\nexpose = "shop/sdk.ts"\n' }, /must be an array/)
  await refused({ 'brust.toml': toml('["/etc/hosts"]') }, /must be relative/)
})

test('R1.1: an exposed file may sit under a source root', async () => {
  const root = tmp()
  mkdirSync(join(root, 'app'))
  mkdirSync(join(root, 'shared'))
  writeFileSync(join(root, 'shared/sdk.ts'), 'export const x = 1\n')
  writeFileSync(join(root, 'app/brust.toml'), '[build]\nsource_roots = ["../shared"]\nexpose = ["../shared/sdk.ts"]\n')
  expect((await loadBuildConfig(join(root, 'app'))).expose).toEqual(['../shared/sdk.ts'])
  // Without the root the same entry is outside everything the app may reach.
  expect(() => parseExpose('brust.toml', join(root, 'app'), [], ['../shared/sdk.ts'])).toThrow(/outside the app root/)
})

test('two exposed modules with one file name get distinct entry names', () => {
  const root = tmp()
  mkdirSync(join(root, 'shop'))
  mkdirSync(join(root, 'other'))
  writeFileSync(join(root, 'shop/sdk.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'other/sdk.ts'), 'export default 2\n')
  const mods = exposedModules(root, ['other/sdk.ts', 'shop/sdk.ts'])
  expect(mods.map((m) => m.stem)).toEqual(['other-sdk', 'shop-sdk'])
  expect(mods.map((m) => m.hasDefault)).toEqual([true, false])
  expect(wrapperSource(mods[0]!)).toContain('export { default } from')
  expect(wrapperSource(mods[1]!)).not.toContain('default')
})

test('R1.3: the stores an exposed module exports: direct, default, renamed, re-exported, imported-then-exported; not a non-literal name or a comment', () => {
  const root = tmp()
  const w = (f: string, text: string) => writeFileSync(join(root, f), text)
  w(
    'sdk.ts',
    [
      "import { defineStore as def, signal } from '@brust/core/store'",
      "import * as st from '@brust/runtime-dom/store'",
      "import { remote } from './remote'",
      "export const direct = def('direct', () => ({ a: signal(0) }))",
      "const hidden = st.defineStore('renamed', () => ({}))",
      "export { hidden as shown }",
      "const local = def('not-exported', () => ({}))",
      "export const dynamicName = def(`x${1}`, () => ({}))",
      "// export const commented = def('commented', () => ({}))",
      "export { remote }",
      "export * from './star'",
      "export { viaFrom as renamedFrom } from './star'",
      'export default def("dflt", () => ({}))',
    ].join('\n'),
  )
  w('remote.ts', "import { defineStore } from '@brust/core/store'\nexport const remote = defineStore('remote', () => ({}))\n")
  w('star.ts', "import { defineStore } from '@brust/core/store'\nexport const fromStar = defineStore('star', () => ({}))\nexport const viaFrom = defineStore('via', () => ({}))\n")
  const got = exposedStores(root, exposedModules(root, ['sdk.ts']))
  expect(got.stores).toEqual({ direct: 'sdk.ts', dflt: 'sdk.ts', remote: 'sdk.ts', renamed: 'sdk.ts', star: 'sdk.ts', via: 'sdk.ts' })
  // `jobs.js` imports the module that calls defineStore for each: here sdk.ts, remote.ts and star.ts.
  expect(got.storeModules).toEqual(['remote.ts', 'sdk.ts', 'star.ts'])
})
