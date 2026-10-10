// `brust build` succeeds and the manifest has the shape the probes rely on (Review Focus 5).
import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '..')
const bin = join(app, '../../../packages/brust/bin/brust')

test('brust build: 3 routes, cache config per probe, typeBadge static child, counter is react with a chunk', async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', 'dist-test'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  const m = await Bun.file(join(app, 'dist-test/manifest.json')).json()
  const byPattern = Object.fromEntries(m.routes.map((r: { pattern: string }) => [r.pattern, r]))
  expect(Object.keys(byPattern).sort()).toEqual(['/dex', '/team', '/types'])
  expect(byPattern['/types'].cache).toEqual({ ttl_seconds: 3600, prefix: null, bypass: null, tags: ['types'] })
  expect(byPattern['/dex'].cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: 'query(nocache)', tags: ['dex'] })
  expect(byPattern['/team'].cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: 'query(nocache)', tags: ['team'] })
  const comp = (prefix: string) => Object.entries(m.components).find(([id]) => id.startsWith(`${prefix}_`))![1] as Record<string, unknown>
  const dex = comp('dexPage') as { tier: string }
  expect(dex.tier).toBe('native')
  // TypeBadge is a plain static child fed by the loader: a job-bearing child in the nested dex list is the build
  // error `nested-instance` (ledger M3), so D measures loader + 151 rows of static children, not the job cache.
  expect((comp('typeBadge') as { tier: string }).tier).toBe('static')
  const counter = comp('counter') as { tier: string; client: string }
  expect(counter.tier).toBe('react')
  expect(counter.client).toMatch(/^client\/react-counter_[0-9a-f]{8}-[0-9a-f]{10}\.js$/)
  rmSync(join(app, 'dist-test'), { recursive: true, force: true })
}, 120_000)
