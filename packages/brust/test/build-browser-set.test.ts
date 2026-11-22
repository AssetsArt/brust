// F610 D1: only the modules some browser bundle holds can spoil a table for the load-time judge. A server-only loader that
// keeps items of a table no longer takes `hosts` from a native chunk that reads the table at load; the same code in a
// module the component imports does.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBuild } from '../src/build'

const FX = join(import.meta.dir, 'fixtures')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

let n = 0
/** A copy of the fixture inside the fixtures directory (so `@brust/core` and `react` resolve), with `files` written over it. */
function variant(files: Record<string, string>): string {
  const dir = join(FX, `.tmp-browser-set-${process.pid}-${n++}`)
  made.push(dir)
  cpSync(join(FX, 'browser-set'), dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
  return dir
}

async function hostsOf(app: string): Promise<Record<string, string[] | undefined>> {
  const out = mkdtempSync(join(tmpdir(), 'brust-browser-set-'))
  made.push(out)
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: out, log: () => {} })
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { components: Record<string, { client: string | null; hosts?: string[] }> }
  const pick = Object.entries(m.components).filter(([id, c]) => id.startsWith('pick') && c.client !== null)
  expect(pick.length).toBe(1)
  return Object.fromEntries(pick.map(([id, c]) => [id, c.hosts]))
}

test('a server-only loader that keeps items of the table does not take hosts from the chunk that reads it at load', async () => {
  const got = await hostsOf(variant({}))
  const [[id, hosts]] = Object.entries(got) as [[string, string[] | undefined]]
  expect(hosts).toEqual([id])
}, 120_000)

test('the same keeping in a module the component imports: the chunk gets no hosts', async () => {
  const app = variant({
    'lib/names.ts': "import { PAGES } from './pages'\n\nexport const NAMES = PAGES.map((p) => p.key)\nconst seen: unknown[] = []\nexport function keep() {\n  for (const p of PAGES) seen.push(p)\n  return seen.length\n}\n",
  })
  const got = await hostsOf(app)
  expect(Object.values(got)).toEqual([undefined])
}, 120_000)
