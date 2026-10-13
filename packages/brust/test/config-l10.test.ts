// L10: slotBytes, maxLoaderResponseBytes and `run({ config: { cors } })`, with exact messages.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrustConfigError, type ConfigOverrides, loadConfig } from '../src/config'
import { startOptions } from '../src/run'

const ENV = ['BRUST_SLOT_BYTES', 'BRUST_MAX_LOADER_RESPONSE_BYTES'] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
const dirs: string[] = []
function tmpApp(toml?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-l10-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  return d
}
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function msg(dir: string, cli: ConfigOverrides = {}): Promise<string> {
  try {
    await loadConfig(dir, cli)
  } catch (e) {
    expect(e).toBeInstanceOf(BrustConfigError)
    return (e as Error).message
  }
  throw new Error('expected loadConfig to throw')
}

test('slotBytes: default 262144, toml [workers] slot_bytes < cli < env', async () => {
  for (const k of ENV) delete process.env[k]
  expect((await loadConfig(tmpApp())).slotBytes).toBe(262_144)
  expect((await loadConfig(tmpApp('[workers]\nslot_bytes = 131072\n'))).slotBytes).toBe(131_072)
  expect((await loadConfig(tmpApp('[workers]\nslot_bytes = 131072\n'), { slotBytes: 524_288 })).slotBytes).toBe(524_288)
  process.env.BRUST_SLOT_BYTES = '1048576'
  expect((await loadConfig(tmpApp('[workers]\nslot_bytes = 131072\n'), { slotBytes: 524_288 })).slotBytes).toBe(1_048_576)
})

test('slotBytes: 64 KiB..16 MiB from every source, exact messages', async () => {
  for (const k of ENV) delete process.env[k]
  expect(await msg(tmpApp(), { slotBytes: 65_535 })).toBe('slotBytes must be an integer in 65536..16777216 (got 65535)')
  expect((await loadConfig(tmpApp(), { slotBytes: 65_536 })).slotBytes).toBe(65_536)
  expect((await loadConfig(tmpApp(), { slotBytes: 16_777_216 })).slotBytes).toBe(16_777_216)
  expect(await msg(tmpApp(), { slotBytes: 16_777_217 })).toContain('slotBytes must be an integer in 65536..16777216')
  const d = tmpApp('[workers]\nslot_bytes = 1024\n')
  expect(await msg(d)).toBe(`${join(d, 'brust.toml')}: workers.slot_bytes must be an integer in 65536..16777216 (got 1024)`)
  process.env.BRUST_SLOT_BYTES = 'big'
  expect(await msg(tmpApp())).toBe('BRUST_SLOT_BYTES must be an integer in 65536..16777216 (got "big")')
})

test('maxLoaderResponseBytes: default 8388608, toml [server] < cli < env, 256 KiB..64 MiB', async () => {
  for (const k of ENV) delete process.env[k]
  expect((await loadConfig(tmpApp())).maxLoaderResponseBytes).toBe(8_388_608)
  const t = tmpApp('[server]\nmax_loader_response_bytes = 1048576\n')
  expect((await loadConfig(t)).maxLoaderResponseBytes).toBe(1_048_576)
  expect((await loadConfig(t, { maxLoaderResponseBytes: 2_097_152 })).maxLoaderResponseBytes).toBe(2_097_152)
  process.env.BRUST_MAX_LOADER_RESPONSE_BYTES = '4194304'
  expect((await loadConfig(t, { maxLoaderResponseBytes: 2_097_152 })).maxLoaderResponseBytes).toBe(4_194_304)
  delete process.env.BRUST_MAX_LOADER_RESPONSE_BYTES
  expect(await msg(tmpApp(), { maxLoaderResponseBytes: 262_143 })).toBe('maxLoaderResponseBytes must be an integer in 262144..67108864 (got 262143)')
  expect(await msg(tmpApp(), { maxLoaderResponseBytes: 67_108_865 })).toContain('262144..67108864')
  const d = tmpApp('[server]\nmax_loader_response_bytes = "8m"\n')
  expect(await msg(d)).toBe(`${join(d, 'brust.toml')}: server.max_loader_response_bytes must be an integer in 262144..67108864 (got "8m")`)
  process.env.BRUST_MAX_LOADER_RESPONSE_BYTES = '1'
  expect(await msg(tmpApp())).toBe('BRUST_MAX_LOADER_RESPONSE_BYTES must be an integer in 262144..67108864 (got "1")')
})

test('startOptions: maxLoaderResponseBytes crosses napi only when it is not the default', async () => {
  for (const k of ENV) delete process.env[k]
  const base = await loadConfig(tmpApp())
  expect('maxLoaderResponseBytes' in startOptions(base, '/d', {}, 'v')).toBe(false)
  const o = startOptions({ ...base, maxLoaderResponseBytes: 1_048_576 }, '/d', {}, 'v')
  expect(o.maxLoaderResponseBytes).toBe(1_048_576)
})

const TOML_CORS = '[cors]\norigins = ["https://toml.example"]\nmethods = ["GET"]\n'

test('cors: run({ config: { cors } }) with no toml [cors]', async () => {
  const cors = { origins: ['https://a.example'], methods: ['GET'], exposeHeaders: ['x-a'], credentials: true, maxAgeSeconds: 60 }
  expect((await loadConfig(tmpApp(), { cors })).cors).toEqual(cors)
  expect((await loadConfig(tmpApp(), { cors: { origins: ['*'] } })).cors).toEqual({ origins: ['*'], credentials: false })
})

test('cors: cli replaces toml as a whole object, never a merge', async () => {
  const cfg = await loadConfig(tmpApp(TOML_CORS), { cors: { origins: ['https://cli.example'] } })
  expect(cfg.cors).toEqual({ origins: ['https://cli.example'], credentials: false }) // toml `methods` did not leak in
  expect((await loadConfig(tmpApp(TOML_CORS))).cors).toEqual({ origins: ['https://toml.example'], methods: ['GET'], credentials: false })
})

test('cors: null turns a toml [cors] off', async () => {
  const cfg = await loadConfig(tmpApp(TOML_CORS), { cors: null })
  expect(cfg.cors).toBeUndefined()
  expect('cors' in cfg).toBe(false)
})

test('cors: programmatic validation, exact messages (camelCase names, null file)', async () => {
  const d = tmpApp()
  const bad = (cors: unknown) => msg(d, { cors: cors as never })
  expect(await bad({ origins: [] })).toBe('config.cors.origins must be non-empty')
  expect(await bad({})).toBe('config.cors.origins must be non-empty')
  expect(await bad({ origins: '*' })).toBe('config.cors.origins must be an array of strings (got "*")')
  expect(await bad({ origins: ['*'], exposeHeaders: 3 })).toBe('config.cors.exposeHeaders must be an array of strings (got 3)')
  expect(await bad({ origins: ['*'], credentials: 'yes' })).toBe('config.cors.credentials must be a boolean (got "yes")')
  expect(await bad({ origins: ['*'], maxAgeSeconds: -1 })).toBe('config.cors.maxAgeSeconds must be an integer in 0..4294967295 (got -1)')
  expect(await bad({ origins: ['*'], credentials: true })).toContain("config.cors.credentials cannot be combined with a wildcard origin '*'")
  expect(await bad(5)).toBe('config.cors must be an object (or null) (got 5)')
  expect(await bad([])).toBe('config.cors must be an object (or null) (got [])')
})

test('cors: an unknown key in the programmatic object is rejected (a toml spelling is not an alias)', async () => {
  const d = tmpApp()
  const e = await msg(d, { cors: { origins: ['*'], expose_headers: ['x'] } as never })
  expect(e).toBe('config.cors.expose_headers is not a cors option (expected origins, methods, headers, exposeHeaders, credentials, maxAgeSeconds)')
})

test('cors: toml messages are unchanged (snake_case, <file>: prefix)', async () => {
  const d = tmpApp('[cors]\norigins = ["*"]\nexpose_headers = 3\n')
  expect(await msg(d)).toBe(`${join(d, 'brust.toml')}: cors.expose_headers must be an array of strings (got 3)`)
})
