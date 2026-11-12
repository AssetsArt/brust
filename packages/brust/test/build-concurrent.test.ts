// F536 A3: two `brust build` of one app started together (as a `brust dev` generation and a `brust build` are) both
// succeed and write the same dist: the package sources under `.brust/pkg-src` are shared between them, so neither may
// delete or rewrite what the other reads. A tiny local package stands in for a published one (no network).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installPlainFmt } from './fixtures/package-helpers/install'

const root = join(import.meta.dir, 'fixtures/package-helpers')
const app = join(root, 'app')
const bin = join(import.meta.dir, '../bin/brust')
let uninstall: () => void

beforeAll(() => {
  uninstall = installPlainFmt(root)
  rmSync(join(app, '.brust'), { recursive: true, force: true })
})
afterAll(() => {
  for (const d of OUTS) rmSync(join(app, d), { recursive: true, force: true })
  rmSync(join(app, '.brust'), { recursive: true, force: true })
  uninstall?.()
})

const OUTS = ['out-a', 'out-b', 'out-c', 'out-d']
const build = async (parent: string) => {
  mkdirSync(join(app, parent), { recursive: true })
  const out = `${parent}/dist`
  const p = Bun.spawn([process.execPath, bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, log: `${stderr}${stdout}` }
}

/** Every file of the dist by relative path, with the hash of its bytes (`jobs.js` without the staging directory's parent). */
const bytesOf = (f: string) => (f.endsWith('jobs.js') ? Buffer.from(readFileSync(f, 'utf8').replaceAll(/out-[a-d]\//g, '')) : readFileSync(f))
const tree = (dir: string, rel = ''): Record<string, string> =>
  Object.fromEntries(
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? Object.entries(tree(dir, join(rel, e.name))) : [[join(rel, e.name), createHash('sha256').update(bytesOf(join(dir, rel, e.name))).digest('hex')]],
    ),
  )

test('builds of the same app started together all succeed with the same dist (3 rounds)', async () => {
  let reference: Record<string, string> | undefined
  for (let round = 0; round < 3; round++) {
    // Round 0 starts with no `.brust/pkg-src`; later rounds find the sources the earlier ones left. Two is the case
    // (a build beside a dev generation); four widens the overlap of builds this small.
    const results = await Promise.all(OUTS.map(build))
    for (const r of results) expect(r.code, r.log).toBe(0)
    for (const out of OUTS) {
      const t = tree(join(app, out, 'dist'))
      expect(Object.keys(t).length).toBeGreaterThan(0)
      reference ??= t
      expect(t).toEqual(reference)
    }
  }
}, 240_000)
