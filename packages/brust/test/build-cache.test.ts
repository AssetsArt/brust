// `[cache] adapter = "custom"` end to end through `brust build` (R7, R8): the bundled module,
// manifest.cache and a stable build id; no [cache] → no manifest key.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runBuild } from '../src/build'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const ROUTES = `import { defineRoutes } from '@brust/core/routes'\nimport Home from './Home'\nexport const routes = defineRoutes([{ path: '/', Component: Home }])\n`
const HOME = (t: string) => `export default function Home() {\n  return <h1>${t}</h1>\n}\n`
const ADAPTER = `import { memoryAdapter } from '@brust/core/cache-adapter'\nexport default () => memoryAdapter()\n`

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(import.meta.dir, '.tmp-app-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries({ 'routes.tsx': ROUTES, 'Home.tsx': HOME('home'), ...files })) writeFileSync(join(dir, name), text)
  return dir
}
const build = (dir: string) => runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: join(dir, 'dist'), log: () => {} })
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'dist', 'manifest.json'), 'utf8'))
const TOML = '[cache]\nadapter = "custom"\nmodule = "cache.ts"\nnamespace = "t"\n[cache.options]\nk = 1\n'

test('custom: dist/cache-adapter.js and manifest.cache with a stable build id', async () => {
  const dir = app({ 'brust.toml': TOML, 'cache.ts': ADAPTER })
  await build(dir)
  expect(existsSync(join(dir, 'dist', 'cache-adapter.js'))).toBe(true)
  const c = manifest(dir).cache
  expect(c).toEqual({ adapter: 'custom', module: 'cache-adapter.js', options: { k: 1 }, namespace: 't', getTimeoutMs: 50, maxBodyBytes: 1048576, epochIntervalMs: 1000, buildId: expect.stringMatching(/^[0-9a-f]{16}$/) })
  await build(dir)
  expect(manifest(dir).cache.buildId).toBe(c.buildId)
  writeFileSync(join(dir, 'Home.tsx'), HOME('changed'))
  await build(dir)
  expect(manifest(dir).cache.buildId).not.toBe(c.buildId)
  const mod = await import(join(dir, 'dist', 'cache-adapter.js'))
  expect(mod.default().name).toBe('memory')
}, 120_000)

test('no [cache] → no cache key in manifest.json', async () => {
  const dir = app({})
  await build(dir)
  expect('cache' in manifest(dir)).toBe(false)
  expect(existsSync(join(dir, 'dist', 'cache-adapter.js'))).toBe(false)
}, 60_000)

test('a module outside the app is refused', async () => {
  const dir = app({ 'brust.toml': '[cache]\nadapter = "custom"\nmodule = "../x.ts"\n' })
  await expect(build(dir)).rejects.toThrow('not a file inside the app')
}, 60_000)
