import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrustConfigError, loadConfig } from '../src/config'

const ENV = ['BRUST_WORKER_THREADS', 'BRUST_ADDR', 'BRUST_PORT', 'BRUST_WORKERS', 'BRUST_RENDER_SLOTS', 'BRUST_DRAIN_TIMEOUT_MS', 'BRUST_BOOT_TIMEOUT_MS', 'BRUST_CALL_TIMEOUT_MS'] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
const dirs: string[] = []
function tmpApp(toml?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-cors-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  return d
}
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function err(toml: string): Promise<BrustConfigError> {
  const dir = tmpApp(toml)
  try {
    await loadConfig(dir)
  } catch (e) {
    expect(e).toBeInstanceOf(BrustConfigError)
    return e as BrustConfigError
  }
  throw new Error('expected loadConfig to throw')
}

test('no [cors] -> cfg.cors undefined', async () => {
  expect((await loadConfig(tmpApp('[server]\nport = 4000\n'))).cors).toBeUndefined()
  expect((await loadConfig(tmpApp())).cors).toBeUndefined()
})

test('full table maps snake_case -> camelCase', async () => {
  const cfg = await loadConfig(
    tmpApp(
      '[cors]\norigins = ["https://a.com", "https://b.com"]\nmethods = ["GET", "POST"]\nheaders = ["x-a"]\nexpose_headers = ["x-b"]\ncredentials = true\nmax_age_seconds = 120\n',
    ),
  )
  expect(cfg.cors).toEqual({
    origins: ['https://a.com', 'https://b.com'],
    methods: ['GET', 'POST'],
    headers: ['x-a'],
    exposeHeaders: ['x-b'],
    credentials: true,
    maxAgeSeconds: 120,
  })
})

test('credentials defaults to false; absent optionals stay absent', async () => {
  const cfg = await loadConfig(tmpApp('[cors]\norigins = ["https://a.com"]\n'))
  expect(cfg.cors).toEqual({ origins: ['https://a.com'], credentials: false })
  expect(Object.keys(cfg.cors ?? {}).sort()).toEqual(['credentials', 'origins'])
})

test('credentials + wildcard origin throws at boot (also when merely contained)', async () => {
  for (const origins of ['["*"]', '["https://a.com", "*"]']) {
    const e = await err(`[cors]\norigins = ${origins}\ncredentials = true\n`)
    expect(e.message).toContain("cors.credentials cannot be combined with a wildcard origin '*'")
    expect(e.message).toContain('brust.toml: ')
  }
})

test('empty origins throws "cors.origins must be non-empty"', async () => {
  expect((await err('[cors]\norigins = []\n')).message).toContain('cors.origins must be non-empty')
  expect((await err('[cors]\ncredentials = false\n')).message).toContain('cors.origins')
})

test('shape errors are BrustConfigError naming <file>: cors.<key>', async () => {
  const cases: [string, string][] = [
    ['cors = 5\n', 'cors'],
    ['[cors]\norigins = "https://a.com"\n', 'cors.origins'],
    ['[cors]\norigins = [1]\n', 'cors.origins'],
    ['[cors]\norigins = ["*"]\nmethods = "GET"\n', 'cors.methods'],
    ['[cors]\norigins = ["*"]\nheaders = [true]\n', 'cors.headers'],
    ['[cors]\norigins = ["*"]\nexpose_headers = 3\n', 'cors.expose_headers'],
    ['[cors]\norigins = ["*"]\ncredentials = "yes"\n', 'cors.credentials'],
    ['[cors]\norigins = ["*"]\nmax_age_seconds = -1\n', 'cors.max_age_seconds'],
  ]
  for (const [toml, key] of cases) {
    const e = await err(toml)
    expect(e.file).toEndWith('brust.toml')
    expect(e.message).toContain(`brust.toml: ${key}`)
  }
})
