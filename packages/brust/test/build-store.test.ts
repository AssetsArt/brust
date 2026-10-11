// M3-F S6: one runtime instance per page. Island + native client builds resolve the store core to the
// runtime bundle URL (external); `@brust/core/server` is server-only in a browser bundle; `jobs.js`
// carries a `stores` table only when the manifest lists store modules.
//
// NOT here yet (core lane / S8): asserting `Symbol.for("brust.reactive.ctx")` appears in exactly one
// `dist/client` file (the runtime) needs the real core store bridge, which does not exist in this lane.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { buildJobs, storeModules } from '../src/build/bundle'

const fx = join(import.meta.dir, 'fixtures')
const outs: string[] = []
const tmpOut = () => {
  const d = mkdtempSync(join(tmpdir(), 'brust-store-'))
  outs.push(d)
  return d
}
/** Inside the package so `jobs.js` resolves `react` when imported. */
const localOut = () => {
  const d = mkdtempSync(join(import.meta.dir, '.tmp-out-'))
  outs.push(d)
  return d
}
afterAll(() => {
  for (const d of outs) rmSync(d, { recursive: true, force: true })
})
const build = (dir: string, outDir: string, entry = 'routes.tsx') => runBuild({ appRoot: dir, entry, outDir, log: () => {} })
const clientTexts = (out: string) => readdirSync(join(out, 'client')).map((f) => ({ f, text: readFileSync(join(out, 'client', f), 'utf8') }))

test('@brust/core/server in an island fails server-only-in-client', async () => {
  await expect(build(join(fx, 'safety/so-core-server'), tmpOut())).rejects.toMatchObject({
    rule: 'server-only-in-client',
    message: expect.stringContaining('Island.tsx imports @brust/core/server'),
  })
}, 60_000)

test('island and native chunks import the store core from the runtime URL', async () => {
  const out = tmpOut()
  await build(join(fx, 'store-bundle'), out)
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  const runtime = (m.assets.runtime as string).slice('client/'.length)
  const ext = /import\{[^}]*\bsignal\b[^}]*\}from"\/_brust\/client\/runtime-[0-9a-f]{10}\.js"/
  const files = clientTexts(out).filter(({ f }) => f !== runtime)
  // The island build emits `react-<id>-*.js` (+ shared `chunk-*.js`); the native build emits `<id>-*.js`.
  // Two separate builds: each must import `signal` externally from the runtime URL (an external import
  // keeps its export name under minify, so this proves the core is NOT bundled).
  const island = files.filter(({ f }) => f.startsWith('react-') || f.startsWith('chunk-'))
  const native = files.filter(({ f }) => !f.startsWith('react-') && !f.startsWith('chunk-'))
  expect(native.length).toBeGreaterThan(0)
  expect(island.length).toBeGreaterThan(0)
  expect(native.some(({ text }) => ext.test(text))).toBe(true)
  expect(island.some(({ text }) => ext.test(text))).toBe(true)
}, 60_000)

test('jobs.js has a stores table only when the manifest lists stores', async () => {
  // (a) no stores: no table.
  const a = localOut()
  await build(join(fx, 'app'), a)
  expect(readFileSync(join(a, 'jobs.js'), 'utf8')).not.toContain('stores')
  // (b) a listed store module is imported and exported by path.
  const b = localOut()
  const app = join(fx, 'store-bundle')
  await buildJobs(b, new Map(), new Map(), app, ['store.ts'])
  const jobs = await import(join(b, 'jobs.js'))
  expect(typeof jobs.stores['store.ts'].hits).toBe('function')
  // the store module's bare @brust/runtime-dom import stays external: no second reactive core in jobs.js
  expect(readFileSync(join(b, 'jobs.js'), 'utf8')).toMatch(/from\s*["']@brust\/runtime-dom["']/)
  for (const p of ['', '.']) {
    await expect(buildJobs(localOut(), new Map(), new Map(), app, [p])).rejects.toMatchObject({ rule: 'store-module' })
  }
  // (c) escaping, absolute or missing paths are a store-module BuildError.
  for (const p of ['../x.ts', 'nope.ts', '/abs/store.ts']) {
    await expect(buildJobs(localOut(), new Map(), new Map(), app, [p])).rejects.toMatchObject({ rule: 'store-module' })
  }
}, 60_000)

test('storeModules is the sorted unique union, tolerant of an absent field', () => {
  expect(storeModules({ components: { a: {}, b: { stores: ['z.ts', 'a.ts'] }, c: { stores: ['a.ts'] } } } as never)).toEqual(['a.ts', 'z.ts'])
  expect(storeModules({ components: {} } as never)).toEqual([])
})

test('jobs.js keeps @brust/runtime-dom/store on the worker core', async () => {
  // The specifier does not resolve until the core lane lands, so no route tree can load it: drive
  // buildJobs with a hand-made react-tier component (the plugin maps the specifier without resolving).
  const out = localOut()
  const app = join(fx, 'store-bundle')
  const c = { id: 'stored', file: join(app, 'Stored.tsx'), ir: { tier: { React: { client_only: false } } } }
  await buildJobs(out, new Map([['stored', c as never]]), new Map(), app)
  const text = readFileSync(join(out, 'jobs.js'), 'utf8')
  expect(text).toMatch(/from\s*"@brust\/core\/store"/)
  expect(text).not.toContain('@brust/runtime-dom/store')
}, 60_000)
