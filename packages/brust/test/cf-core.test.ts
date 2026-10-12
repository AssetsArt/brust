import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCoreCf } from '../src/build/cf-core'

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
  expect(() => resolveCoreCf({ ...base, env: {} })).toThrow(/bun add -d @brust\/core-cf@/)
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
