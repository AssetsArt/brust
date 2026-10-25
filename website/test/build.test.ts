// website/test/build.test.ts — the site builds clean, and every foundation component compiles to the tier the plan's
// tier table claims (verified by the A1.1 spike).
import { afterAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '..')
const bin = join(app, '../packages/brust/bin/brust')
const outs: string[] = []

interface Manifest {
  routes: { pattern: string }[]
  components: Record<string, { tier: string; client: string | null; jobs: { kind: string }[] }>
}

function build(entry: string, out: string): Manifest {
  outs.push(join(app, out))
  rmSync(join(app, out), { recursive: true, force: true }) // a leftover from a killed run never leaks into this one
  const b = Bun.spawnSync([bin, 'build', entry, '--out-dir', out], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  return JSON.parse(readFileSync(join(app, out, 'manifest.json'), 'utf8'))
}

/** Component record by source name (`codeBlock_<hash>` → `CodeBlock`). */
function component(m: Manifest, name: string) {
  const prefix = `${name[0]!.toLowerCase()}${name.slice(1)}_`
  const hits = Object.entries(m.components).filter(([id]) => id.startsWith(prefix))
  expect([name, hits.length]).toEqual([name, 1])
  return hits[0]![1]
}

afterAll(() => {
  for (const o of outs) rmSync(o, { recursive: true, force: true })
}, 60_000)

test('brust build routes.tsx: routes /, /docs (+ docs pages), *; the layout chrome is static with no jobs', () => {
  const m = build('routes.tsx', 'dist-test')
  // the /demo/... routes (Guide demos) sit between / and the docs block
  const patterns = m.routes.map((r) => r.pattern).filter((p) => !p.startsWith('/demo/'))
  expect(patterns.slice(0, 2)).toEqual(['/', '/docs'])
  expect(patterns.at(-1)).toBe('*')
  for (const name of ['Layout', 'SiteHeader', 'SiteFooter', 'NotFoundPage']) {
    const c = component(m, name)
    expect([name, c.tier, c.jobs.length, c.client]).toEqual([name, 'static', 0, null])
  }
}, 120_000)

test('tier table: CodeBlock static (0 jobs), CopyButton native, Button static', () => {
  const m = build('test/fixtures/routes.tsx', 'dist-test-fx')
  expect(m.routes.map((r) => r.pattern)).toEqual(['/foundation', '*'])
  const tiers: Record<string, [string, number]> = { CodeBlock: ['static', 0], CopyButton: ['native', 0], Button: ['static', 0], Layout: ['static', 0] }
  for (const [name, [tier, jobs]] of Object.entries(tiers)) {
    const c = component(m, name)
    expect([name, c.tier, c.jobs.length]).toEqual([name, tier, jobs])
  }
  expect(component(m, 'CopyButton').client).toMatch(/^client\/copyButton_/)
}, 120_000)
