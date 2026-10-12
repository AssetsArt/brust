// website/test/build.test.ts — the docs site builds, has exactly its three routes, and ships no client JavaScript yet.
import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '..')
const bin = join(app, '../packages/brust/bin/brust')

test('brust build: routes /, /docs, * — every component static, no client chunks', async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', 'dist-test'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  const m = await Bun.file(join(app, 'dist-test/manifest.json')).json()
  expect(m.routes.map((r: { pattern: string }) => r.pattern)).toEqual(['/', '/docs', '*'])
  for (const [id, c] of Object.entries(m.components as Record<string, { tier: string; client: string | null }>)) {
    expect([id, c.tier]).toEqual([id, 'static'])
    expect([id, c.client]).toEqual([id, null])
  }
  rmSync(join(app, 'dist-test'), { recursive: true, force: true })
}, 120_000)
