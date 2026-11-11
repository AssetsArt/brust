import { availableParallelism } from 'node:os'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'

const ENV = ['BRUST_STATS', 'BRUST_WORKER_THREADS', 'BRUST_ADDR', 'BRUST_PORT', 'BRUST_WORKERS', 'BRUST_RENDER_SLOTS', 'BRUST_DRAIN_TIMEOUT_MS', 'BRUST_BOOT_TIMEOUT_MS', 'BRUST_CALL_TIMEOUT_MS'] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
const dirs: string[] = []
function tmpApp(toml?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-config-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  return d
}
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('precedence: env > CLI flags > brust.toml > defaults', async () => {
  for (const k of ENV) delete process.env[k]
  const bare = await loadConfig(tmpApp())
  expect(bare.host).toBe('localhost')
  expect(bare.port).toBe(1337)
  expect(bare.workers).toBeGreaterThanOrEqual(1)
  expect([bare.renderSlots, bare.drainTimeoutMs]).toEqual([Math.min(availableParallelism(), 16), 10000])

  const dir = tmpApp('[server]\naddress = "0.0.0.0"\nport = 4000\n[workers]\ncount = 3\n')
  const toml = await loadConfig(dir)
  expect([toml.host, toml.port, toml.workers]).toEqual(['0.0.0.0', 4000, 3])
  expect((await loadConfig(dir, { port: 4500, workers: 2 })).port).toBe(4500)
  expect((await loadConfig(dir, { port: 4500, workers: 2 })).workers).toBe(2)
  process.env.BRUST_PORT = '5000'
  process.env.BRUST_WORKERS = '5'
  process.env.BRUST_ADDR = '127.0.0.1'
  process.env.BRUST_RENDER_SLOTS = '4'
  process.env.BRUST_DRAIN_TIMEOUT_MS = '250'
  const env = await loadConfig(dir, { port: 4500, workers: 2 })
  expect([env.host, env.port, env.workers, env.renderSlots, env.drainTimeoutMs]).toEqual(['127.0.0.1', 5000, 5, 4, 250])
})

test('BRUST_BOOT_TIMEOUT_MS: default 30000, env > CLI, validated', async () => {
  for (const k of ENV) delete process.env[k]
  expect((await loadConfig(tmpApp())).bootTimeoutMs).toBe(30000)
  expect((await loadConfig(tmpApp(), { bootTimeoutMs: 1000 })).bootTimeoutMs).toBe(1000)
  process.env.BRUST_BOOT_TIMEOUT_MS = '60000'
  expect((await loadConfig(tmpApp(), { bootTimeoutMs: 1000 })).bootTimeoutMs).toBe(60000)
  process.env.BRUST_BOOT_TIMEOUT_MS = '1.5'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_BOOT_TIMEOUT_MS must be an integer in 1..4294967295')
  process.env.BRUST_BOOT_TIMEOUT_MS = '0'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_BOOT_TIMEOUT_MS must be an integer in 1..4294967295')
})

test('BRUST_CALL_TIMEOUT_MS: default 30000, env > CLI, 0 and junk rejected', async () => {
  for (const k of ENV) delete process.env[k]
  expect((await loadConfig(tmpApp())).callTimeoutMs).toBe(30000)
  expect((await loadConfig(tmpApp(), { callTimeoutMs: 1000 })).callTimeoutMs).toBe(1000)
  process.env.BRUST_CALL_TIMEOUT_MS = '60000'
  expect((await loadConfig(tmpApp(), { callTimeoutMs: 1000 })).callTimeoutMs).toBe(60000)
  for (const bad of ['0', 'abc', '4294967296']) {
    process.env.BRUST_CALL_TIMEOUT_MS = bad
    await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_CALL_TIMEOUT_MS must be an integer in 1..4294967295')
  }
})

test('validation: messages name the source and the rule', async () => {
  for (const k of ENV) delete process.env[k]
  process.env.BRUST_PORT = 'abc'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_PORT must be an integer in 1..65535')
  delete process.env.BRUST_PORT
  await expect(loadConfig(tmpApp('[workers]\ncount = 0\n'))).rejects.toThrow('workers.count must be an integer in 1..1024')
  await expect(loadConfig(tmpApp('[server]\nport = 70000\n'))).rejects.toThrow('server.port must be an integer in 1..65535')
  await expect(loadConfig(tmpApp('[server\n'))).rejects.toThrow('failed to parse')
  // A CLI `--port 0` asks the OS for a free port (e2e); env/toml must name a real one.
  expect((await loadConfig(tmpApp(), { port: 0 })).port).toBe(0)
})

test('ms timeouts must fit a u32 (the napi boundary) instead of wrapping', async () => {
  for (const k of ENV) delete process.env[k]
  process.env.BRUST_DRAIN_TIMEOUT_MS = '4294967296'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_DRAIN_TIMEOUT_MS must be an integer in 0..4294967295')
  process.env.BRUST_DRAIN_TIMEOUT_MS = '4294967295'
  expect((await loadConfig(tmpApp())).drainTimeoutMs).toBe(4294967295)
  delete process.env.BRUST_DRAIN_TIMEOUT_MS
  process.env.BRUST_BOOT_TIMEOUT_MS = String(2 ** 32 + 5)
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_BOOT_TIMEOUT_MS must be an integer in 1..4294967295')
  delete process.env.BRUST_BOOT_TIMEOUT_MS
  await expect(loadConfig(tmpApp(), { bootTimeoutMs: 2 ** 32 })).rejects.toThrow('bootTimeoutMs must be an integer in 1..4294967295')
  await expect(loadConfig(tmpApp(), { drainTimeoutMs: -1 })).rejects.toThrow('drainTimeoutMs must be an integer in 0..4294967295')
})

test('port is 0..65535 and workers 1..1024 from every source (CLI flags included)', async () => {
  for (const k of ENV) delete process.env[k]
  await expect(loadConfig(tmpApp(), { port: 70000 })).rejects.toThrow('--port must be an integer in 0..65535 (got 70000)')
  await expect(loadConfig(tmpApp(), { port: -1 })).rejects.toThrow('--port must be an integer in 0..65535')
  await expect(loadConfig(tmpApp(), { workers: 0 })).rejects.toThrow('--workers must be an integer in 1..1024 (got 0)')
  await expect(loadConfig(tmpApp(), { workers: 1025 })).rejects.toThrow('--workers must be an integer in 1..1024')
  expect((await loadConfig(tmpApp(), { port: 65535, workers: 1024 })).workers).toBe(1024)
  process.env.BRUST_WORKERS = '2000'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_WORKERS must be an integer in 1..1024')
  delete process.env.BRUST_WORKERS
  await expect(loadConfig(tmpApp('[workers]\ncount = 5000\n'))).rejects.toThrow('workers.count must be an integer in 1..1024')
})

test('renderSlots is 1..64 from every source (a huge value is a config error, not an OOM)', async () => {
  for (const k of ENV) delete process.env[k]
  process.env.BRUST_RENDER_SLOTS = '100000'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_RENDER_SLOTS must be an integer in 1..64 (got "100000")')
  process.env.BRUST_RENDER_SLOTS = '0'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_RENDER_SLOTS must be an integer in 1..64')
  process.env.BRUST_RENDER_SLOTS = '64'
  expect((await loadConfig(tmpApp())).renderSlots).toBe(64)
  delete process.env.BRUST_RENDER_SLOTS
  await expect(loadConfig(tmpApp(), { renderSlots: 65 })).rejects.toThrow('renderSlots must be an integer in 1..64 (got 65)')
  await expect(loadConfig(tmpApp(), { renderSlots: 100000 })).rejects.toMatchObject({ name: 'BrustConfigError' })
})

test('BRUST_WORKER_THREADS: absent = server default (one per core), env > CLI, bounds 1..256', async () => {
  for (const k of ENV) delete process.env[k]
  expect((await loadConfig(tmpApp())).ioThreads).toBeUndefined()
  expect((await loadConfig(tmpApp(), { ioThreads: 6 })).ioThreads).toBe(6)
  process.env.BRUST_WORKER_THREADS = '12'
  expect((await loadConfig(tmpApp(), { ioThreads: 6 })).ioThreads).toBe(12)
  for (const bad of ['0', 'abc', '257']) {
    process.env.BRUST_WORKER_THREADS = bad
    await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_WORKER_THREADS must be an integer in 1..256')
  }
  delete process.env.BRUST_WORKER_THREADS
  await expect(loadConfig(tmpApp(), { ioThreads: 0 })).rejects.toThrow('ioThreads must be an integer in 1..256')
})

// F507: `[server] stats` / `stats_token`, and the BRUST_STATS env layer.
test('stats: absent by default; toml, CLI and env set it, env > CLI > toml', async () => {
  for (const k of ENV) delete process.env[k]
  expect((await loadConfig(tmpApp())).stats).toBeUndefined()
  expect(await loadConfig(tmpApp('[server]\nstats = "public"\n'))).toMatchObject({ stats: 'public' })
  const tok = await loadConfig(tmpApp('[server]\nstats = "token"\nstats_token = "env:STATS_TOKEN"\n'))
  expect(tok).toMatchObject({ stats: 'token', statsToken: 'env:STATS_TOKEN' })
  const dir = tmpApp('[server]\nstats = "public"\n')
  expect((await loadConfig(dir, { stats: 'off' })).stats).toBe('off')
  process.env.BRUST_STATS = 'off'
  expect((await loadConfig(dir, { stats: 'public' })).stats).toBe('off')
  process.env.BRUST_STATS = ''
  expect((await loadConfig(dir)).stats).toBe('public') // an empty env var counts as unset
})

test('stats: a bad mode, a literal token and a mode/token mismatch are config errors that never echo a secret', async () => {
  for (const k of ENV) delete process.env[k]
  const fails = async (toml: string, msg: string | RegExp, cli: Parameters<typeof loadConfig>[1] = {}) => {
    const e = await loadConfig(tmpApp(toml), cli).then(() => null, (x: Error) => x)
    expect(e?.message).toMatch(msg)
    return e!.message
  }
  await fails('[server]\nstats = "yes"\n', /server\.stats must be one of off, public, token \(got "yes"\)/)
  const m = await fails('[server]\nstats = "token"\nstats_token = "hunter2-literal"\n', /server\.stats_token must be "env:NAME" \(a literal token is refused/)
  expect(m).not.toContain('hunter2-literal')
  await fails('[server]\nstats = "token"\n', /stats = "token" needs stats_token = "env:NAME"/)
  await fails('[server]\nstats = "public"\nstats_token = "env:T"\n', /stats_token is used only with stats = "token"/)
  await fails('[server]\nstats_token = "env:T"\n', /stats_token is used only with stats = "token"/)
  await fails('', /config\.stats must be one of/, { stats: 'maybe' as never })
  await fails('', /config\.stats_token must be "env:NAME"/, { stats: 'token', statsToken: 'literal' })
  process.env.BRUST_STATS = 'maybe'
  await fails('', /BRUST_STATS must be one of off, public, token \(got "maybe"\)/)
})

test('F519 [components] cache_entries: absent by default, 1..1_000_000 from brust.toml or run({ config }), passed to startServer', async () => {
  for (const k of ENV) delete process.env[k]
  expect((await loadConfig(tmpApp())).componentsCacheEntries).toBeUndefined()
  expect((await loadConfig(tmpApp('[components]\ncache_entries = 500\n'))).componentsCacheEntries).toBe(500)
  await expect(loadConfig(tmpApp('[components]\ncache_entries = 0\n'))).rejects.toThrow('components.cache_entries must be an integer in 1..1000000 (got 0)')
  await expect(loadConfig(tmpApp('[components]\ncache_entries = "big"\n'))).rejects.toMatchObject({ name: 'BrustConfigError' })
  expect((await loadConfig(tmpApp('[components]\ncache_entries = 500\n'), { componentsCacheEntries: 9 })).componentsCacheEntries).toBe(9)
  await expect(loadConfig(tmpApp(), { componentsCacheEntries: 0 })).rejects.toThrow('componentsCacheEntries must be an integer in 1..1000000 (got 0)')
  const { startOptions } = await import('../src/run')
  const cfg = await loadConfig(tmpApp('[components]\ncache_entries = 7\n'))
  // biome-ignore lint/suspicious/noExplicitAny: the run manifest fields startOptions reads
  expect(startOptions(cfg, '/dist', { routes: [] } as any, '0.0.0').componentsCacheEntries).toBe(7)
  // biome-ignore lint/suspicious/noExplicitAny: as above
  expect('componentsCacheEntries' in startOptions(await loadConfig(tmpApp()), '/dist', { routes: [] } as any, '0.0.0')).toBe(false)
})
