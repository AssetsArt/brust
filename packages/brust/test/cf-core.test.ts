import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedWorkerd } from '../src/build/cf-workerd'
import { resolveCoreCf } from '../src/build/cf-core'
import { prepareCloudflare } from '../src/build/cloudflare'
import type { CloudflareBuildConfig } from '../src/build/config'

const FIX = join(import.meta.dir, 'fixtures', 'cf-core')
const dirs: string[] = []
const copy = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'brust-cfcore-'))
  dirs.push(d)
  cpSync(FIX, d, { recursive: true })
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const base = { appRoot: tmpdir(), fromSource: false }

test('BRUST_CORE_CF_DIR resolves; metadata and workerDir are read', () => {
  const r = resolveCoreCf({ ...base, env: { BRUST_CORE_CF_DIR: FIX } })
  expect(r.workerDir).toBe(join(FIX, 'worker'))
  expect(r.meta).toEqual({ abi: 1, main: 'index.js', glue: 'index.js', appModuleDir: '.', compatibilityDate: '2026-10-01' })
})

test('abi 2 is a cf-wasm error', () => {
  const d = copy()
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@brust/core-cf', version: '1.0.0', brust: { abi: 2 } }))
  expect(() => resolveCoreCf({ ...base, env: { BRUST_CORE_CF_DIR: d } })).toThrow(/abi 2/)
})

test('a missing worker/<main> names the install hint', () => {
  const d = copy()
  rmSync(join(d, 'worker', 'index.js'))
  try {
    resolveCoreCf({ ...base, env: { BRUST_CORE_CF_DIR: d } })
    throw new Error('did not throw')
  } catch (e) {
    expect((e as { rule: string }).rule).toBe('cf-wasm')
    expect((e as Error).message).toContain('bun add -d @brust/core-cf@')
  }
})

test('a version differing from @brust/core only warns', () => {
  const d = copy()
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@brust/core-cf', version: '0.0.1', brust: { abi: 1 } }))
  expect(resolveCoreCf({ ...base, env: { BRUST_CORE_CF_DIR: d } }).warnings).toHaveLength(1)
})

test('not installed anywhere -> cf-wasm error with the hint', () => {
  // corePkgDir outside the monorepo: since @brust/core-cf is an optionalDependency of @brust/core (M4-CF-6), the repo's own packages/brust resolves it.
  expect(() => resolveCoreCf({ ...base, env: {}, corePkgDir: copy() })).toThrow(/bun add -d @brust\/core-cf@/)
})

test('--wasm-from-source without crates/brust-wasm is an error', () => {
  const pkg = copy() // a "core package dir" with no ../../crates
  expect(() => resolveCoreCf({ ...base, fromSource: true, env: {}, corePkgDir: pkg })).toThrow(/needs crates\/brust-wasm/)
})

test('--wasm-from-source runs the lane-3 build script once, in the repo root', () => {
  const repo = mkdtempSync(join(tmpdir(), 'brust-cfrepo-'))
  dirs.push(repo)
  cpSync(FIX, join(repo, 'npm', 'core-cf'), { recursive: true })
  cpSync(FIX, join(repo, 'packages', 'brust'), { recursive: true })
  cpSync(FIX, join(repo, 'crates', 'brust-wasm'), { recursive: true })
  const calls: { cmd: string[]; cwd: string }[] = []
  const r = resolveCoreCf({ ...base, fromSource: true, env: {}, corePkgDir: join(repo, 'packages', 'brust'), run: (cmd, cwd) => (calls.push({ cmd, cwd }), 0), which: () => '/bin/x' })
  expect(calls).toEqual([{ cmd: ['bun', join('crates', 'brust-wasm', 'scripts', 'build.ts')], cwd: repo }])
  expect(r.dir).toBe(join(repo, 'npm', 'core-cf'))
})

// ---- F482: the default compatibility_date is bounded by the workerd the app has installed ----

/** A fake npm package: `package.json` (and `lib/main.js` exporting `compatibilityDate` when `date` is given). */
function pkg(dir: string, name: string, version: string, date?: string): void {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  if (date) writeFileSync(join(dir, 'lib', 'main.js'), `var compatibilityDate = "${date}";\nvar version = "${version}";\n`)
}
/** An app whose wrangler -> miniflare -> workerd are hoisted, workerd at `date` (undefined: not installed). */
function app(date?: string, version = `1.${(date ?? '2026-09-28').replaceAll('-', '')}.0`): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-cfwd-'))
  dirs.push(d)
  pkg(join(d, 'node_modules', 'wrangler'), 'wrangler', '4.136.1')
  pkg(join(d, 'node_modules', 'miniflare'), 'miniflare', '5.20260928.0')
  if (date) pkg(join(d, 'node_modules', 'workerd'), 'workerd', version, date)
  return d
}
const CORE_FIX = { BRUST_CORE_CF_DIR: FIX } // compatibilityDate 2026-10-01
const CFG: CloudflareBuildConfig = { name: undefined, compatibilityDate: undefined, l1Capacity: 256, jobCacheCapacity: 512, stats: false, edgeCache: 'off', alias: {} }
const prep = (root: string, cfg: CloudflareBuildConfig | null = CFG) => prepareCloudflare(root, cfg, { fromSource: false, env: CORE_FIX })
const compatOf = (p: Awaited<ReturnType<typeof prep>>) => p.cfg.compatibilityDate ?? p.core.meta.compatibilityDate

test('F482 D1: the default is the core date bounded by an older installed workerd', async () => {
  const p = await prep(app('2026-09-28'))
  expect(compatOf(p)).toBe('2026-09-28')
  expect(p.warnings.filter((w) => w.includes('cf-compat-date'))).toEqual([])
})

test('F482 D1: a workerd newer than the core keeps the core date; none installed keeps it too', async () => {
  expect(compatOf(await prep(app('2026-11-05')))).toBe('2026-10-01')
  expect(compatOf(await prep(app(undefined)))).toBe('2026-10-01')
  expect(compatOf(await prep(mkdtempSync(join(tmpdir(), 'brust-cfwd-none-'))))).toBe('2026-10-01')
})

test('F482 D1: a workerd older than brust supports keeps the core date and warns once (the deploy build must not break)', async () => {
  const p = await prep(app('2026-05-01'))
  expect(compatOf(p)).toBe('2026-10-01')
  const w = p.warnings.filter((x) => x.includes('cf-compat-date'))
  expect(w).toHaveLength(1)
  expect(w[0]).toContain('2026-05-01')
  expect(w[0]).toContain('upgrade wrangler')
})

test('F482 D2: an explicit date is used as written, with a named warning only when it outruns workerd', async () => {
  const root = app('2026-09-28')
  const newer = await prep(root, { ...CFG, compatibilityDate: '2026-10-01' })
  expect(compatOf(newer)).toBe('2026-10-01')
  const w = newer.warnings.filter((x) => x.includes('cf-compat-date'))
  expect(w).toHaveLength(1)
  expect(w[0]).toContain('compatibility_date 2026-10-01')
  expect(w[0]).toContain('2026-09-28')
  expect(w[0]).toContain('1.20260928.0')
  for (const d of ['2026-09-28', '2026-09-01']) {
    const q = await prep(root, { ...CFG, compatibilityDate: d })
    expect(compatOf(q)).toBe(d)
    expect(q.warnings.filter((x) => x.includes('cf-compat-date'))).toEqual([])
  }
  // no workerd to compare with: no warning
  expect((await prep(app(undefined), { ...CFG, compatibilityDate: '2026-10-01' })).warnings.filter((x) => x.includes('cf-compat-date'))).toEqual([])
})

test('F482: the workerd that wrangler runs is the one read (a nested install beats a hoisted decoy); the date falls back to the version', () => {
  const root = app('2026-11-05') // hoisted decoy, newer
  pkg(join(root, 'node_modules', 'wrangler', 'node_modules', 'miniflare'), 'miniflare', '5.20260928.0')
  // nested under wrangler's miniflare, no lib/main.js: the date comes from the version `1.YYYYMMDD.n`
  pkg(join(root, 'node_modules', 'wrangler', 'node_modules', 'miniflare', 'node_modules', 'workerd'), 'workerd', '1.20260928.1')
  expect(installedWorkerd(root)).toMatchObject({ date: '2026-09-28', version: '1.20260928.1' })
  // without wrangler the app's own workerd is read
  const alone = mkdtempSync(join(tmpdir(), 'brust-cfwd-alone-'))
  dirs.push(alone)
  pkg(join(alone, 'node_modules', 'workerd'), 'workerd', '1.20260811.1', '2026-08-11')
  expect(installedWorkerd(alone)).toMatchObject({ date: '2026-08-11' })
})
