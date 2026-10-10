// examples/pokedex/test/build.test.ts — `brust build` succeeds and the manifest has the S13 shape.
import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '..')
const bin = join(app, '../../packages/brust/bin/brust')

test('brust build: 5 routes; detailPage has a job and a per-row TypeBadge; teamBuilder is react with a chunk; the catch-all is static', async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', 'dist-test'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  const m = await Bun.file(join(app, 'dist-test/manifest.json')).json()
  expect(m.routes.map((r: { pattern: string }) => r.pattern)).toEqual(['/', '/pokedex', '/pokemon/{name}', '/type-chart', '*'])
  const detail = m.routes.find((r: { pattern: string }) => r.pattern === '/pokemon/{name}')
  expect(detail.cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: 'query(nocache)', tags: ['pokemon'] })
  const comp = (prefix: string) => Object.entries(m.components).find(([id]) => id.startsWith(`${prefix}_`))![1] as Record<string, unknown>
  const d = comp('detailPage') as { tier: string; jobs: { kind: string; inputs: string[] }[]; children: { id: string; instances: string }[] }
  expect(d.tier).toBe('static') // F70: the page reads only props; TypeBadge (loop-only props) is plain HTML, its job survives
  expect(d.jobs.some((j) => j.kind === 'precompute' && j.inputs.includes('height') && j.inputs.includes('weight'))).toBe(true)
  expect(d.children.some((c) => c.id.startsWith('typeBadge_') && c.instances === 'per-row:typeNames')).toBe(true)
  const layout = comp('appLayout') as { jobs: { kind: string; target?: string }[] }
  expect(layout.jobs.some((j) => j.kind === 'ssr' && j.target?.startsWith('teamBuilder_'))).toBe(true)
  const team = comp('teamBuilder') as { tier: string; client: string }
  expect(team.tier).toBe('react')
  expect(team.client).toMatch(/^client\/react-teamBuilder_[0-9a-f]{8}-[0-9a-f]{10}\.js$/)
  const nf = comp('notFoundPage') as { tier: string; client: string | null }
  expect(nf).toMatchObject({ tier: 'static', client: null })
  rmSync(join(app, 'dist-test'), { recursive: true, force: true })
}, 120_000)
