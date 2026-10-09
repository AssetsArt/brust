import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bin = join(import.meta.dir, '../bin/brust')
const bad = join(import.meta.dir, 'fixtures/bad')
const run = (args: string[], cwd = import.meta.dir) => {
  const p = Bun.spawnSync([bin, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRUST_PORT: '' } })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

test('brust start without a build exits 1 and says to build first', () => {
  const r = run(['start', '--dist-dir', '/nonexistent'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('run brust build first')
})

test('brust build on a broken app exits 1 with `error <rule>` and writes no manifest', () => {
  const out = mkdtempSync(join(tmpdir(), 'brust-cli-'))
  try {
    const r = run(['build', 'routes.tsx', '--out-dir', out], join(bad, 'outlet-leaf'))
    expect(r.code).toBe(1)
    expect(r.err).toContain('error outlet-outside-layout')
    expect(existsSync(join(out, 'manifest.json'))).toBe(false)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('usage: --help exits 0, an unknown command exits 2', () => {
  const h = run(['--help'])
  expect(h.code).toBe(0)
  expect(h.out).toContain('brust build')
  expect(h.out).toContain('brust start')
  const u = run(['frobnicate'])
  expect(u.code).toBe(2)
  expect(u.err).toContain('unknown command frobnicate')
})
