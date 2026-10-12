import { describe, expect, test } from 'bun:test'
import { closeSync, cpSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CORE_CF_WORKER_FILES, E2E_MARKER } from './core-cf-check'

const REPO = resolve(import.meta.dir, '..')
const CHECK = join(import.meta.dir, 'core-cf-check.ts')
const run = (args: string[]) => {
  const r = Bun.spawnSync(['bun', CHECK, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
function pkg(): string {
  const d = mkdtempSync(join(tmpdir(), 'core-cf-check-'))
  cpSync(join(REPO, 'npm/core-cf/package.json'), join(d, 'package.json'))
  for (const f of CORE_CF_WORKER_FILES) {
    mkdirSync(join(d, f, '..'), { recursive: true })
    writeFileSync(join(d, f), f.endsWith('.wasm') ? '\0asm\x01\0\0\0' : '// fake\n')
  }
  return d
}

describe('core-cf-check', () => {
  test('a good package → exit 0 with the size line', () => {
    const r = run([pkg()])
    expect(r.code).toBe(0)
    expect(r.out).toContain('core-cf wasm raw=8 gzip=')
  })
  test('missing worker/index.js → exit 1 naming it', () => {
    const d = pkg(); Bun.spawnSync(['rm', join(d, 'worker/index.js')])
    const r = run([d])
    expect(r.code).toBe(1)
    expect(r.err).toContain('worker/index.js: missing')
  })
  test('an extra worker/foo.map → exit 1 naming it', () => {
    const d = pkg(); writeFileSync(join(d, 'worker/foo.map'), '{}')
    const r = run([d])
    expect(r.code).toBe(1)
    expect(r.err).toContain('worker/foo.map: unexpected')
  })
  test('a 4 MiB wasm → exit 1', () => {
    const d = pkg(); const fd = openSync(join(d, 'worker/index_bg.wasm'), 'r+'); ftruncateSync(fd, 4 * 1024 * 1024); closeSync(fd)
    const r = run([d])
    expect(r.code).toBe(1)
    expect(r.err).toContain('≥ 4194304')
  })
  test('the e2e marker in the wasm → exit 1', () => {
    const d = pkg(); writeFileSync(join(d, 'worker/index_bg.wasm'), `\0asm${E2E_MARKER}`)
    const r = run([d])
    expect(r.code).toBe(1)
    expect(r.err).toContain('e2e build')
  })
  test('brust.abi 2 → exit 1', () => {
    const d = pkg(); const f = join(d, 'package.json')
    writeFileSync(f, readFileSync(f, 'utf8').replace('"abi": 1', '"abi": 2'))
    const r = run([d])
    expect(r.code).toBe(1)
    expect(r.err).toContain('brust.abi')
  })
  test('--versions: Cargo.toml worker pin ≠ brust.workerBuild → exit 1', () => {
    const d = pkg(); const c = join(d, 'Cargo.toml'); writeFileSync(c, '[dependencies]\nworker = "=0.8.6"\n')
    const r = run([d, '--versions', c])
    expect(r.code).toBe(1)
    expect(r.err).toContain('worker-build 0.8.7 ≠ worker =0.8.6')
  })
  test('--versions against the real crate → exit 0', () => {
    expect(run([pkg(), '--versions', join(REPO, 'crates/brust-wasm/Cargo.toml')]).code).toBe(0)
  })
  test('--pack: the tarball listing equals the allow-list', () => {
    const r = run([pkg(), '--pack'])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('tarball checked')
  })
})
