// F614: an import handed to an app function that only reads it is not a write. A `.ts` module hands an imported table
// to its own read-only check; nothing writes the table, so the interactive child that reads it through another module
// stays native, its static parent gets no job, and the page that renders the grandparent under a condition (omitting a
// prop whose module default guards a second placement) builds with its `<Dynamic>`.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'

const app = join(import.meta.dir, 'fixtures', 'handed-read-only')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

test('the build succeeds, the interactive child stays native and the page is not a React island', async () => {
  const out = mkdtempSync(join(tmpdir(), 'brust-f614-'))
  made.push(out)
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: out, log: () => {} })
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { components: Record<string, { tier: string; client: string | null }> }
  const of = (p: string) => Object.entries(m.components).filter(([id]) => id.startsWith(p))
  expect(of('page_').map(([, c]) => c.tier)).not.toContain('react')
  expect(of('live_').length).toBeGreaterThan(0)
  for (const [, c] of of('live_')) {
    expect(c.tier).toBe('native')
    expect(c.client).not.toBeNull()
  }
}, 120_000)
