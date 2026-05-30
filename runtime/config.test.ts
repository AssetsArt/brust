import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'

// loadConfig reads BRUST_PORT / BRUST_ADDR / BRUST_WORKERS from the environment.
// Snapshot and clear them so each case controls precedence explicitly.
const SAVED: Record<string, string | undefined> = {}
const ENV_KEYS = ['BRUST_PORT', 'BRUST_ADDR', 'BRUST_WORKERS']
let dir: string

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k]
    delete process.env[k]
  }
  dir = await mkdtemp(join(tmpdir(), 'brust-config-'))
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
  await rm(dir, { recursive: true, force: true })
})

test('defaults to localhost:1337 when nothing is configured', async () => {
  const cfg = await loadConfig(dir)
  expect(cfg.host).toBe('localhost')
  expect(cfg.port).toBe(1337)
})

test('opts defaults fill in when env and toml are absent', async () => {
  const cfg = await loadConfig(dir, { host: '0.0.0.0', port: 4000 })
  expect(cfg.host).toBe('0.0.0.0')
  expect(cfg.port).toBe(4000)
})

test('env BRUST_ADDR / BRUST_PORT win over opts defaults', async () => {
  process.env.BRUST_ADDR = '127.0.0.1'
  process.env.BRUST_PORT = '8080'
  const cfg = await loadConfig(dir, { host: '0.0.0.0', port: 4000 })
  expect(cfg.host).toBe('127.0.0.1')
  expect(cfg.port).toBe(8080)
})

test('toml server.address / server.port win over opts but lose to env', async () => {
  await writeFile(join(dir, 'brust.toml'), '[server]\naddress = "0.0.0.0"\nport = 5000\n')
  const tomlOnly = await loadConfig(dir, { host: 'localhost', port: 4000 })
  expect(tomlOnly.host).toBe('0.0.0.0')
  expect(tomlOnly.port).toBe(5000)

  process.env.BRUST_PORT = '8080'
  const envWins = await loadConfig(dir, { host: 'localhost', port: 4000 })
  expect(envWins.port).toBe(8080)
  expect(envWins.host).toBe('0.0.0.0') // address still from toml
})
