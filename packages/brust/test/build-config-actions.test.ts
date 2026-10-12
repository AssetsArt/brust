import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBuildConfig } from '../src/build/config'

const dirs: string[] = []
function tmpApp(toml?: string, files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-bcfg-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function fails(toml: string, tail: string) {
  const d = tmpApp(toml)
  const err = await loadBuildConfig(d).then(
    () => null,
    (e) => e as { rule?: string; message: string },
  )
  expect(err).not.toBeNull()
  expect(err?.rule).toBe('config')
  expect(err?.message).toBe(`${join(d, 'brust.toml')}: ${tail}`)
}

test('no [actions] table -> actions null, even with an actions.ts present (R6)', async () => {
  expect((await loadBuildConfig(tmpApp('[build]\nserver_only = ["x"]\n', { 'actions.ts': '' }))).actions).toBeNull()
  expect((await loadBuildConfig(tmpApp(undefined, { 'actions.ts': '' }))).actions).toBeNull()
  expect((await loadBuildConfig(tmpApp('[build]\n'))).actions).toBeNull()
})

test('empty [actions] -> defaults', async () => {
  const c = await loadBuildConfig(tmpApp('[actions]\n'))
  expect(c.actions).toEqual({ entry: 'actions.ts', prefix: '/_brust/action', maxBodyBytes: 1048576, maxResponseBytes: 8388608, crossSite: 'reject' })
})

test('explicit values; leading ./ stripped from entry', async () => {
  const c = await loadBuildConfig(tmpApp('[actions]\nentry = "./server/api.ts"\nprefix = "/api"\nmax_body_bytes = 1024\nmax_response_bytes = 1048576\n'))
  expect(c.actions).toEqual({ entry: 'server/api.ts', prefix: '/api', maxBodyBytes: 1024, maxResponseBytes: 1048576, crossSite: 'reject' })
})

test('cross_site: "allow" is kept, "reject" is the default, anything else is a build error (F87)', async () => {
  expect((await loadBuildConfig(tmpApp('[actions]\ncross_site = "allow"\n'))).actions?.crossSite).toBe('allow')
  expect((await loadBuildConfig(tmpApp('[actions]\ncross_site = "reject"\n'))).actions?.crossSite).toBe('reject')
  await fails('[actions]\ncross_site = "maybe"\n', 'actions.cross_site must be "reject" or "allow"')
  await fails('[actions]\ncross_site = true\n', 'actions.cross_site must be "reject" or "allow"')
})

test('invalid [actions] values fail with BuildError config', async () => {
  await fails('actions = 1\n', '[actions] must be a table')
  await fails('[actions]\nentry = ""\n', 'actions.entry must be a non-empty string')
  await fails('[actions]\nprefix = "/api/"\n', `actions.prefix must start with '/', be longer than '/' and have no trailing '/' (got "/api/")`)
  await fails('[actions]\nprefix = "/_brust"\n', `actions.prefix /_brust is reserved for the server's own /_brust/ paths`)
  await fails('[actions]\nmax_body_bytes = 0\n', 'actions.max_body_bytes must be an integer in 1..67108864 (got 0)')
  await fails('[actions]\nmax_body_bytes = 1.5\n', 'actions.max_body_bytes must be an integer in 1..67108864 (got 1.5)')
  await fails('[actions]\nmax_body_bytes = 67108865\n', 'actions.max_body_bytes must be an integer in 1..67108864 (got 67108865)')
  await fails('[actions]\nmax_response_bytes = 262143\n', 'actions.max_response_bytes must be an integer in 262144..67108864 (got 262143)')
  await fails('[actions]\nmax_response_bytes = 1.5\n', 'actions.max_response_bytes must be an integer in 262144..67108864 (got 1.5)')
  await fails('[actions]\nmax_response_bytes = 67108865\n', 'actions.max_response_bytes must be an integer in 262144..67108864 (got 67108865)')
})

test('[build] server_only still parses alongside [actions]', async () => {
  const c = await loadBuildConfig(tmpApp('[build]\nserver_only = ["./lib/server", "@acme/db"]\n[actions]\nprefix = "/rpc"\n'))
  expect(c.serverOnly).toEqual(['lib/server', '@acme/db'])
  expect(c.actions?.prefix).toBe('/rpc')
})
