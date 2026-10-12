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
