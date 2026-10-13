// `brust build --target static` with `[actions]` (gaps round L12): the static tree plus the Pages
// `_worker.js`, `_routes.json` and the Pages project file, built with the fake core-cf fixture (no
// wasm; the workerd half is tests/cf/static-actions.test.ts). Run alone: `bun test --timeout 300000 test/static-actions.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoCacheBindings, pagesConfig, routesJson, workerSource } from '../src/build/static-worker'
import { resolveCoreCf } from '../src/build/cf-core'

const fixture = join(import.meta.dir, 'fixtures/static-actions')
const core = join(import.meta.dir, 'fixtures/cf-core')
const bin = join(import.meta.dir, '../bin/brust')
const dist = join(fixture, 'dist')
const copies: string[] = []

function build(cwd: string, env: Record<string, string> = {}) {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'static'], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', BRUST_CORE_CF_DIR: core, ...env } })
  return { code: b.exitCode, stdout: b.stdout.toString(), stderr: b.stderr.toString() }
}

function variant(name: string, edit: (dir: string) => void): string {
  const dir = join(import.meta.dir, `fixtures/.static-actions-${name}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes('/dist') })
  copies.push(dir)
  edit(dir)
  return dir
}

let built: ReturnType<typeof build>
beforeAll(() => {
  rmSync(dist, { recursive: true, force: true })
  built = build(fixture)
})
afterAll(() => {
  rmSync(dist, { recursive: true, force: true })
  for (const d of copies) rmSync(d, { recursive: true, force: true })
})

test('R12: the build writes the static pages and the Pages worker next to them', () => {
  expect(built.stderr).toBe('')
  expect(built.code).toBe(0)
  for (const f of ['index.html', 'about.html', '404.html', '_headers', '_redirects', 'ssg.json', '_routes.json', '_worker.js/index.js', '_worker.js/core/index.js'])
    expect(existsSync(join(dist, 'static', f))).toBe(true)
  expect(readFileSync(join(dist, 'static/index.html'), 'utf8')).toContain('static actions home')
  expect(built.stdout).toContain('actions under /api are served by _worker.js')
})

test('R12: the cf/ tree is not left in the dist; the project file sits next to static/', () => {
  expect(existsSync(join(dist, 'cf'))).toBe(false)
  const cfg = Bun.JSONC.parse(readFileSync(join(dist, 'wrangler.jsonc'), 'utf8')) as Record<string, unknown>
  expect(cfg).toEqual({ name: 'brust-static-actions', pages_build_output_dir: './static', compatibility_date: '2026-10-01' })
})

test('R12.1: _routes.json includes only the prefix; the worker falls through to ASSETS', () => {
  expect(JSON.parse(readFileSync(join(dist, 'static/_routes.json'), 'utf8'))).toEqual({ version: 1, include: ['/api', '/api/*'], exclude: [] })
  const w = readFileSync(join(dist, 'static/_worker.js/index.js'), 'utf8')
  expect(w).toBe(workerSource('index.js', '/api'))
  expect(w).toContain('env.ASSETS.fetch(request)')
  const report = JSON.parse(readFileSync(join(dist, 'static/ssg.json'), 'utf8')) as { actions: unknown; pages: { path: string }[] }
  expect(report.actions).toEqual({ prefix: '/api', worker: '_worker.js' })
  expect(report.pages.map((p) => p.path).sort()).toEqual(['/', '/about'])
})

test('R12: a core-cf fixture without a worker is cf-wasm, and the previous dist survives', () => {
  const b = build(fixture, { BRUST_CORE_CF_DIR: join(import.meta.dir, 'fixtures/does-not-exist') })
  expect(b.code).toBe(1)
  expect(b.stderr).toContain('cf-wasm')
  expect(existsSync(join(dist, 'static/_worker.js/index.js'))).toBe(true)
})

test('R12: an [actions] app without a static plan problem still refuses a KV/DO cache adapter, nothing is written', () => {
  const kv = variant('kv', (d) => {
    writeFileSync(join(d, 'brust.toml'), '[actions]\nentry = "actions.ts"\nprefix = "/api"\n\n[cache]\nadapter = "cloudflare-kv"\n')
    mkdirSync(join(d, 'node_modules/@brust'), { recursive: true })
    symlinkSync(join(import.meta.dir, '../../cache-cloudflare'), join(d, 'node_modules/@brust/cache-cloudflare'))
  })
  const b = build(kv)
  expect(b.code).toBe(1)
  expect(b.stderr).toStartWith('error ssg-actions-cache [cache] adapter "cloudflare-kv" needs a Cloudflare binding (KV BRUST_CACHE)')
  expect(existsSync(join(kv, 'dist'))).toBe(false)
})

test('pure helpers: routesJson, pagesConfig dates, assertNoCacheBindings', () => {
  expect(JSON.parse(routesJson('/_brust/action'))).toEqual({ version: 1, include: ['/_brust/action', '/_brust/action/*'], exclude: [] })
  expect(() => assertNoCacheBindings(undefined)).not.toThrow()
  expect(() => assertNoCacheBindings({ adapter: 'redis', options: {}, broadcast: undefined, broadcastOptions: undefined })).not.toThrow()
  expect(() => assertNoCacheBindings({ adapter: 'cloudflare-do', options: {}, broadcast: undefined, broadcastOptions: undefined })).toThrow(/Durable Object BRUST_CACHE_DO/)
  const p = { cfg: { name: undefined, compatibilityDate: '2026-01-01' }, core: resolveCoreCf({ appRoot: fixture, fromSource: false, env: { BRUST_CORE_CF_DIR: core } }), pkgName: undefined } as never
  expect(() => pagesConfig(p)).toThrow(/older than/)
})
