import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBuildConfig } from '../src/build/config'

const dirs: string[] = []
function tmpApp(toml?: string, files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-cfcfg-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(join(d, k, '..'), { recursive: true })
    writeFileSync(join(d, k), v)
  }
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function fails(toml: string, tail: string | RegExp, files: Record<string, string> = {}) {
  const d = tmpApp(toml, files)
  const err = await loadBuildConfig(d).then(
    () => null,
    (e) => e as { rule?: string; message: string },
  )
  expect(err).not.toBeNull()
  expect(err?.rule).toBe('config')
  if (typeof tail === 'string') expect(err?.message).toBe(`${join(d, 'brust.toml')}: ${tail}`)
  else expect(err?.message).toMatch(tail)
}

test('no [cloudflare] table -> null; empty table -> defaults', async () => {
  expect((await loadBuildConfig(tmpApp())).cloudflare).toBeNull()
  expect((await loadBuildConfig(tmpApp('[build]\nserver_only=["x"]\n'))).cloudflare).toBeNull()
  expect((await loadBuildConfig(tmpApp('[cloudflare]\n'))).cloudflare).toEqual({
    name: undefined,
    compatibilityDate: undefined,
    l1Capacity: 256,
    jobCacheCapacity: 512,
    stats: false,
    edgeCache: 'off',
    alias: {},
  })
})

test('every key parses', async () => {
  const d = tmpApp(
    '[cloudflare]\nname="my-app"\ncompatibility_date="2026-09-01"\nl1_capacity=64\njob_cache_capacity=8\nstats=true\nedge_cache="off"\n[cloudflare.alias]\n"lib/db.ts"="lib/db.cf.ts"\n',
    { 'lib/db.ts': 'export {}', 'lib/db.cf.ts': 'export {}' },
  )
  const c = (await loadBuildConfig(d)).cloudflare
  expect(c).toMatchObject({ name: 'my-app', compatibilityDate: '2026-09-01', l1Capacity: 64, jobCacheCapacity: 8, stats: true, edgeCache: 'off' })
  expect(Object.entries(c?.alias ?? {}).map(([k, v]) => [k.endsWith('lib/db.ts'), v.endsWith('lib/db.cf.ts')])).toEqual([[true, true]])
})

test('bad types are config errors', async () => {
  await fails('[cloudflare]\nname=3\n', 'cloudflare.name must be a non-empty string')
  await fails('[cloudflare]\nstats="yes"\n', 'cloudflare.stats must be a boolean')
  await fails('[cloudflare]\nl1_capacity=0\n', /cloudflare\.l1_capacity must be an integer in 1\.\./)
  await fails('[cloudflare]\njob_cache_capacity="a"\n', /cloudflare\.job_cache_capacity must be an integer in 1\.\./)
  await fails('cloudflare=3\n', '[cloudflare] must be a table')
  await fails('[cloudflare]\ncompatibility_date="soon"\n', 'cloudflare.compatibility_date must be YYYY-MM-DD')
})

test('compatibility_date below 2026-08-04 is an error', async () => {
  await fails('[cloudflare]\ncompatibility_date="2026-08-03"\n', 'cloudflare.compatibility_date must be >= 2026-08-04 (nodejs_compat is default from then)')
})

test('edge_cache workers-cache names M4-CF-7; other values are errors', async () => {
  await fails('[cloudflare]\nedge_cache="workers-cache"\n', /M4-CF-7/)
  await fails('[cloudflare]\nedge_cache="x"\n', /cloudflare\.edge_cache/)
})

test('alias to a missing file, a non-table alias and unknown keys are errors', async () => {
  await fails('[cloudflare.alias]\n"a.ts"="b.ts"\n', /cloudflare\.alias: cannot resolve/)
  await fails('[cloudflare]\nalias=3\n', 'cloudflare.alias must be a table of module paths')
  await fails('[cloudflare]\naccount_id="x"\n', 'cloudflare.account_id is not a known key')
})
