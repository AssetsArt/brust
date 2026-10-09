import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'

const ENV = ['BRUST_ADDR', 'BRUST_PORT', 'BRUST_WORKERS', 'BRUST_RENDER_SLOTS', 'BRUST_DRAIN_TIMEOUT_MS'] as const
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
  expect([bare.renderSlots, bare.drainTimeoutMs]).toEqual([1, 10000])

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

test('validation: messages name the source and the rule', async () => {
  for (const k of ENV) delete process.env[k]
  process.env.BRUST_PORT = 'abc'
  await expect(loadConfig(tmpApp())).rejects.toThrow('BRUST_PORT must be an integer in 1..65535')
  delete process.env.BRUST_PORT
  await expect(loadConfig(tmpApp('[workers]\ncount = 0\n'))).rejects.toThrow('workers.count must be a positive integer')
  await expect(loadConfig(tmpApp('[server]\nport = 70000\n'))).rejects.toThrow('server.port must be an integer in 1..65535')
  await expect(loadConfig(tmpApp('[server\n'))).rejects.toThrow('failed to parse')
  // A CLI `--port 0` asks the OS for a free port (e2e); env/toml must name a real one.
  expect((await loadConfig(tmpApp(), { port: 0 })).port).toBe(0)
})
