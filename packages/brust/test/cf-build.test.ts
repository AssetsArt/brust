import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const FIX = join(import.meta.dir, 'fixtures')
const CORE = join(FIX, 'cf-core')
const cleanup: string[] = []
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

function brust(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, env: { ...process.env, BRUST_CORE_CF_DIR: CORE, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const outDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'brust-cfbuild-'))
  cleanup.push(d)
  return d
}

const APP = join(FIX, 'cf-app')
let built: { out: string; r: ReturnType<typeof brust> } | undefined
function build() {
  if (!built) {
    const out = join(outDir(), 'dist')
    built = { out, r: brust(APP, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', out]) }
  }
  return built
}

test('builds the dist/cf tree', () => {
  const { out, r } = build()
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  for (const f of ['worker/index.js', 'worker/index_bg.wasm', 'worker/brust-app.js', '.stage/brust-app.entry.js', 'assets/_headers', 'assets/public/favicon.svg', 'wrangler.jsonc'])
    expect(existsSync(join(out, 'cf', f))).toBe(true)
  expect(readdirClient(join(out, 'cf', 'assets', '_brust', 'client')).some((f) => /^runtime-.*\.js$/.test(f))).toBe(true)
  const w = Bun.JSONC.parse(readFileSync(join(out, 'cf', 'wrangler.jsonc'), 'utf8')) as Record<string, unknown>
  expect(w.kv_namespaces).toEqual([{ binding: 'KV', id: 'fixture-kv' }])
  expect(w.main).toBe('worker/index.js')
  expect(JSON.stringify(w)).not.toContain('account_id')
  expect(readFileSync(join(out, 'cf', '.stage', 'brust-app.entry.js'), 'utf8').trimEnd().split('\n').length).toBeLessThanOrEqual(25)
})

function readdirClient(d: string): string[] {
  return require('node:fs').readdirSync(d)
}

test('brust-app.js is self-contained, honours [cloudflare] alias and stays small', () => {
  const { out } = build()
  const js = readFileSync(join(out, 'cf', 'worker', 'brust-app.js'), 'utf8')
  for (const bad of ['../native/index.js', '.node"', 'worker_threads', 'bun:']) expect(js).not.toContain(bad)
  // `@brust/core` resolves to cf.ts under `workerd`, not browser.ts (ruling c30e2633): cache.invalidate is the live one.
  expect(js).not.toContain('cache.invalidate is server-only')
  expect(js).toContain('installedRuntime().invalidate(a)')
  expect(js).toMatch(/export \{[^}]*\binstall\b/)
  expect(js).toContain('D1_DB_MARKER')
  expect(js).not.toContain('BUN_DB_MARKER')
  expect(js.length).toBeLessThan(2 * 1024 * 1024)
})

test('an import of bun:sqlite fails with cf-unsupported', () => {
  const dir = join(FIX, 'cf-app-bad')
  cleanup.push(dir)
  cpSync(APP, dir, { recursive: true })
  writeFileSync(join(dir, 'lib', 'db.cf.ts'), "import { Database } from 'bun:sqlite'\nexport const dbName = String(Database)\n")
  const r = brust(dir, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', join(outDir(), 'dist')])
  expect(r.code).toBe(1)
  expect(r.err).toContain('error cf-unsupported')
  expect(r.err).toContain('lib/db.cf.ts imports bun:sqlite')
})

test('--target nope is a usage error; without --target there is no dist/cf', () => {
  expect(brust(APP, ['build', 'routes.tsx', '--target', 'nope']).code).toBe(2)
  const out = join(outDir(), 'dist')
  const r = brust(APP, ['build', 'routes.tsx', '--out-dir', out])
  expect(r.code).toBe(0)
  expect(existsSync(join(out, 'cf'))).toBe(false)
})

test('cache.invalidate inside an action reaches the installed runtime (R8, ruling 19753649)', async () => {
  const { out } = build()
  const stage = join(out, 'cf', '.stage')
  writeFileSync(
    join(stage, 'invalidate-probe.ts'),
    `const m = await import(${JSON.stringify(join(out, 'cf', 'worker', 'brust-app.js'))})
const seen: unknown[] = []
m.install({ invalidate: (a: unknown) => (seen.push(a), { l1Removed: 7, jobRemoved: 1 }) })
const res = await m.action(new Request('http://x/api/invalidate'))
console.log(JSON.stringify({ status: res.status, body: await res.json(), seen }))
`,
  )
  const r = Bun.spawnSync([process.execPath, '--preload', join(stage, 'smoke-preload.ts'), join(stage, 'invalidate-probe.ts')], { cwd: APP, stdout: 'pipe', stderr: 'pipe' })
  expect(r.stderr.toString()).toBe('')
  expect(JSON.parse(r.stdout.toString())).toEqual({ status: 200, body: { l1Removed: 7, jobRemoved: 1 }, seen: [{ tags: ['x'] }] })
})

function appWithToml(extra: string): string {
  const dir = join(FIX, 'cf-app-cors')
  rmSync(dir, { recursive: true, force: true })
  cleanup.push(dir)
  cpSync(APP, dir, { recursive: true })
  writeFileSync(join(dir, 'brust.toml'), `${readFileSync(join(APP, 'brust.toml'), 'utf8')}\n${extra}\n`)
  return dir
}
const configOf = (out: string) => {
  const js = readFileSync(join(out, 'cf', 'worker', 'brust-app.js'), 'utf8')
  return JSON.parse(/CONFIG = '(.*)'/.exec(js)![1]!) as Record<string, unknown>
}

test('[cors] reaches CONFIG, even with an unrelated bad env var on the build host (F1)', () => {
  const dir = appWithToml('[cors]\norigins = ["https://ok.example"]\ncredentials = true')
  const out = join(outDir(), 'dist')
  const r = brust(dir, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', out], { BRUST_PORT: 'abc' })
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(configOf(out).cors).toEqual({ origins: ['https://ok.example'], credentials: true })
})

test('an invalid [cors] fails the build before anything is written (F1)', () => {
  const dir = appWithToml('[cors]\norigins = "https://ok.example"')
  const out = join(outDir(), 'dist')
  const r = brust(dir, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', out])
  expect(r.code).toBe(1)
  expect(r.err).toContain('error config')
  expect(r.err).toContain('cors.origins')
  expect(existsSync(out)).toBe(false)
})

function appWithCache(adapterSrc: string, extra = ''): string {
  const dir = join(FIX, 'cf-app-cache')
  rmSync(dir, { recursive: true, force: true })
  cleanup.push(dir)
  cpSync(APP, dir, { recursive: true })
  writeFileSync(join(dir, 'brust.toml'), `${readFileSync(join(APP, 'brust.toml'), 'utf8')}\n[cache]\nadapter = "custom"\nmodule = "cache.ts"\n${extra}\n`)
  writeFileSync(join(dir, 'cache.ts'), adapterSrc)
  return dir
}

test('a pull custom adapter builds: CONFIG.cache (Workers get timeout 100) and the install wrapper', () => {
  const dir = appWithCache(`import { memoryAdapter } from '@brust/core/cache-adapter'\nexport default () => memoryAdapter({ broadcast: 'pull' })\n`)
  const out = join(outDir(), 'dist')
  const r = brust(dir, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', out])
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  const c = configOf(out).cache as Record<string, unknown>
  expect(c).toMatchObject({ adapter: 'custom', getTimeoutMs: 100, maxBodyBytes: 1048576, epochIntervalMs: 1000 })
  expect(c.buildId).toMatch(/^[0-9a-f]{16}$/)
  expect(readFileSync(join(out, 'cf', '.stage', 'brust-app.entry.js'), 'utf8')).toContain('installRuntime(rt, { adapter: CACHE')
})

test('a push-only custom adapter fails the build (R14)', () => {
  const dir = appWithCache(`import { memoryAdapter } from '@brust/core/cache-adapter'\nexport default () => memoryAdapter({ broadcast: 'push' })\n`)
  const r = brust(dir, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', join(outDir(), 'dist')])
  expect(r.code).toBe(1)
  expect(r.err).toContain('error cf-smoke')
  expect(r.err).toContain('push-only')
})

test('an adapter without "workers" in runtimes fails the build (R14)', () => {
  const dir = appWithCache(`import { memoryAdapter } from '@brust/core/cache-adapter'\nexport default () => ({ ...memoryAdapter({ broadcast: 'pull' }), runtimes: ['bun'] })\n`)
  const r = brust(dir, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', join(outDir(), 'dist')])
  expect(r.code).toBe(1)
  expect(r.err).toContain('does not run on Cloudflare Workers')
})

test('an env: option is refused on --target cloudflare', () => {
  const dir = appWithCache(`import { memoryAdapter } from '@brust/core/cache-adapter'\nexport default () => memoryAdapter({ broadcast: 'pull' })\n`, '[cache.options]\nurl = "env:URL"')
  const r = brust(dir, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', join(outDir(), 'dist')])
  expect(r.code).toBe(1)
  expect(r.err).toContain('"env:" values are not available on Cloudflare Workers')
})
