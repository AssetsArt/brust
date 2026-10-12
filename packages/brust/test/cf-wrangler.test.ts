import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeWrangler, readUserWrangler, renderWrangler } from '../src/build/cf-wrangler'

const dirs: string[] = []
const app = (files: Record<string, string>): string => {
  const d = mkdtempSync(join(tmpdir(), 'brust-cfw-'))
  dirs.push(d)
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const JSONC = `// my worker
{
  "name": "from-wrangler",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",
  "compatibility_flags": ["some_flag"],
  "build": { "command": "echo hi" },
  "assets": { "directory": "./public" },
  "vars": { "A": "1", },
  "routes": [{ "pattern": "example.com/*", "zone_name": "example.com" }],
  "kv_namespaces": [{ "binding": "KV", "id": "kv1" }],
  "d1_databases": [
    { "binding": "DB", "database_name": "d", "database_id": "d1" },
    { "binding": "DB2", "database_name": "e", "database_id": "e1", "migrations_dir": "db/mig" },
  ],
  "env": { "staging": { "d1_databases": [{ "binding": "DB", "database_name": "s", "database_id": "s1" }], "main": "x.ts" } },
}
`
const opts = (root: string) => ({ appRoot: root, cfDir: join(root, 'dist', 'cf'), compatibilityDate: '2026-10-01', main: 'index.js', version: '2.0.0-alpha.2' })

test('bindings survive; owned keys are brust\'s; rebased paths', async () => {
  const root = app({ 'wrangler.jsonc': JSONC })
  const { config, warnings } = mergeWrangler(await readUserWrangler(root), opts(root))
  expect(config.vars).toEqual({ A: '1' })
  expect(config.routes).toEqual([{ pattern: 'example.com/*', zone_name: 'example.com' }])
  expect(config.kv_namespaces).toEqual([{ binding: 'KV', id: 'kv1' }])
  expect(config.compatibility_flags).toEqual(['some_flag'])
  const dbs = config.d1_databases as { migrations_dir: string }[]
  expect(dbs.map((d) => d.migrations_dir)).toEqual(['../../migrations', '../../db/mig'])
  const stg = (config.env as { staging: { d1_databases: { migrations_dir: string }[] } }).staging
  expect(stg.d1_databases[0]!.migrations_dir).toBe('../../migrations')
  expect(config.main).toBe('worker/index.js')
  expect(config.compatibility_date).toBe('2026-10-01')
  expect(config.assets).toEqual({ directory: 'assets', binding: 'ASSETS', run_worker_first: false, html_handling: 'none', not_found_handling: 'none' })
  expect(config.build).toBeUndefined()
  expect((config.env as { staging: Record<string, unknown> }).staging.main).toBeUndefined()
  expect(config.name).toBe('from-wrangler')
  for (const k of ['main', 'assets', 'compatibility_date', 'build'])
    expect(warnings).toContain(`[brust] wrangler: ${k} is owned by brust build --target cloudflare; ignored`)
  expect(warnings.some((w) => w.includes('env.staging') && w.includes('main'))).toBe(true)
})

test('name precedence: [cloudflare] name > wrangler name > package.json; conflict warns', async () => {
  const root = app({ 'wrangler.jsonc': '{"name":"w"}' })
  const r1 = mergeWrangler(await readUserWrangler(root), { ...opts(root), name: 'toml' })
  expect(r1.config.name).toBe('toml')
  expect(r1.warnings.some((w) => w.includes('name'))).toBe(true)
  const root2 = app({})
  expect(mergeWrangler(await readUserWrangler(root2), { ...opts(root2), pkgName: '@acme/My_App' }).config.name).toBe('my-app')
})

test('no_nodejs_compat flag, an ASSETS binding and three config files are errors', async () => {
  const r1 = app({ 'wrangler.jsonc': '{"compatibility_flags":["no_nodejs_compat_v2"]}' })
  expect(() => mergeWrangler({ file: 'x', config: { compatibility_flags: ['no_nodejs_compat'] } }, opts(r1))).toThrow(/cf-config|nodejs_compat/)
  const bad = { file: 'x', config: { kv_namespaces: [{ binding: 'ASSETS', id: 'a' }] } }
  expect(() => mergeWrangler(bad, opts(r1))).toThrow(/ASSETS/)
  const three = app({ 'wrangler.jsonc': '{}', 'wrangler.json': '{}', 'wrangler.toml': 'name="x"' })
  await expect(readUserWrangler(three)).rejects.toMatchObject({ rule: 'cf-config' })
})

test('account_id: never added, kept verbatim when the user wrote it', async () => {
  const root = app({ 'wrangler.jsonc': '{"name":"n"}' })
  expect(JSON.stringify(mergeWrangler(await readUserWrangler(root), opts(root)).config)).not.toContain('account_id')
  const root2 = app({ 'wrangler.jsonc': '{"name":"n","account_id":"abc123"}' })
  expect(mergeWrangler(await readUserWrangler(root2), opts(root2)).config.account_id).toBe('abc123')
})

test('toml input equals the jsonc input', async () => {
  const j = app({ 'wrangler.jsonc': '{"name":"n","vars":{"A":"1"},"kv_namespaces":[{"binding":"KV","id":"k"}],"d1_databases":[{"binding":"DB","database_name":"d","database_id":"i"}]}' })
  const t = app({ 'wrangler.toml': 'name="n"\n[vars]\nA="1"\n[[kv_namespaces]]\nbinding="KV"\nid="k"\n[[d1_databases]]\nbinding="DB"\ndatabase_name="d"\ndatabase_id="i"\n' })
  const a = mergeWrangler(await readUserWrangler(j), opts(j)).config
  const b = mergeWrangler(await readUserWrangler(t), { ...opts(t), appRoot: j, cfDir: join(j, 'dist', 'cf') }).config
  expect(b).toEqual(a)
})

test('no user file starts from {}; render = header + 2-space JSON', async () => {
  const root = app({})
  const { config } = mergeWrangler(await readUserWrangler(root), { ...opts(root), pkgName: 'demo' })
  const text = renderWrangler(config)
  expect(text.startsWith('// generated by `brust build --target cloudflare`')).toBe(true)
  expect(Bun.JSONC.parse(text)).toEqual(config)
  expect(text.endsWith('}\n')).toBe(true)
})
