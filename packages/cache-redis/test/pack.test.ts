// R15: the packed tarball ships only package.json, README.md and src/**, and `bun pm pack` rewrites
// the `workspace:*` peer to the exact @brust/core version (the publish path is `bun publish`, same rewrite).
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const pkgDir = resolve(import.meta.dir, '..')
const out = mkdtempSync(join(tmpdir(), 'cache-redis-pack-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

test('the tarball lists only package.json, README.md, src/** and has no workspace: ref', () => {
  const p = Bun.spawnSync(['bun', 'pm', 'pack', '--destination', out], { cwd: pkgDir, stdout: 'pipe', stderr: 'pipe' })
  expect(p.exitCode).toBe(0)
  const tgz = readdirSync(out).filter((f) => f.endsWith('.tgz'))
  expect(tgz.length).toBe(1)
  const file = join(out, tgz[0]!)
  const list = Bun.spawnSync(['tar', '-tzf', file], { stdout: 'pipe' }).stdout.toString().trim().split('\n')
  for (const f of list) expect(f).toMatch(/^package\/(package\.json|README\.md|src\/[^/]+\.ts)$/)
  expect(list).toContain('package/src/index.ts')
  expect(list).toContain('package/src/dragonfly.ts')
  const packed = JSON.parse(Bun.spawnSync(['tar', '-xOzf', file, 'package/package.json'], { stdout: 'pipe' }).stdout.toString()) as {
    peerDependencies: Record<string, string>
    dependencies?: Record<string, string>
  }
  const coreVersion = (JSON.parse(readFileSync(join(pkgDir, '../brust/package.json'), 'utf8')) as { version: string }).version
  expect(JSON.stringify(packed)).not.toContain('workspace:')
  expect(packed.peerDependencies['@brust/core']).toBe(coreVersion)
  expect(packed.dependencies ?? {}).toEqual({})
})
