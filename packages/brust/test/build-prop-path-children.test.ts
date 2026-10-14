// F148a (R34.116-R34.121): a static wrapper whose React island renders `{title}` and `{children}` stays static; the island
// gets its holes (`$p<N>`) as props and the caller's tree (`$c<N>`) as a bound constant. Hydration and the hostile
// loader are `tests/server/prop-path-children.chromium.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runBuild } from '../src/build'

const app = join(import.meta.dir, 'fixtures/prop-path-children')
const dist = join(app, 'dist')

afterAll(() => rmSync(dist, { recursive: true, force: true }))

test('the wrapper and the page stay static; the island carries holes, not request data in its tree', async () => {
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {}, force: true })
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
  expect(tiers.page).toBe('static')
  expect(tiers.frame).toBe('static')
  expect(tiers.disclosure).toBe('react')
  // The tree's skeleton is constant (in the manifest, with the job): the value nodes name island props, and the
  // revive is told which names are its own, `$c<N>` (a caller's tree) and `$p<N>` (primitives).
  expect(readFileSync(join(dist, 'manifest.json'), 'utf8')).toMatch(/"\$brust": "v"/)
  const jobs = readFileSync(join(dist, 'jobs.js'), 'utf8')
  expect(jobs).toMatch(/__mk\(Disclosure, props, \[\], \["\$c\d+", "\$p0"/)
  const chunk = readdirSync(join(dist, 'client')).find((f) => f.startsWith('react-disclosure_'))!
  expect(readFileSync(join(dist, 'client', chunk), 'utf8')).toContain('$p0')
})
