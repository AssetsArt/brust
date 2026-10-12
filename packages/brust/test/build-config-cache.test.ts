// `[cache]` in brust.toml (cache adapters, spec §6, R4, R8): parsed and validated at build.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBuildConfig } from '../src/build/config'

const dirs: string[] = []
function tmpApp(toml: string, files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-ccfg-'))
  dirs.push(d)
  writeFileSync(join(d, 'brust.toml'), toml)
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function err(toml: string, files: Record<string, string> = {}) {
  const e = await loadBuildConfig(tmpApp(toml, files)).then(
    () => null,
    (x) => x as { rule?: string; message: string },
  )
  expect(e).not.toBeNull()
  return e!
}

test('no [cache] table → cache: null', async () => {
  expect((await loadBuildConfig(tmpApp('[actions]\n'))).cache).toBeNull()
})

test('custom with module and options; defaults; namespace from package.json', async () => {
  const c = (await loadBuildConfig(tmpApp('[cache]\nadapter = "custom"\nmodule = "lib/cache.ts"\n[cache.options]\nurl = "x"\n', { 'package.json': '{"name":"my-app"}' }))).cache
  expect(c).toEqual({
    adapter: 'custom',
    module: 'lib/cache.ts',
    broadcast: undefined,
    options: { url: 'x' },
    broadcastOptions: undefined,
    namespace: 'my-app',
    getTimeoutMs: undefined,
    maxBodyBytes: 1048576,
    epochIntervalMs: 1000,
  })
})

test('namespace falls back to "brust"; explicit values win', async () => {
  const c = (await loadBuildConfig(tmpApp('[cache]\nadapter = "custom"\nmodule = "c.ts"\nget_timeout_ms = 200\nmax_body_bytes = 2048\nepoch_interval_ms = 250\n'))).cache!
  expect([c.namespace, c.getTimeoutMs, c.maxBodyBytes, c.epochIntervalMs]).toEqual(['brust', 200, 2048, 250])
  const n = (await loadBuildConfig(tmpApp('[cache]\nadapter = "custom"\nmodule = "c.ts"\nnamespace = "pokedex"\n'))).cache!
  expect(n.namespace).toBe('pokedex')
})

test('custom without module', async () => {
  expect((await err('[cache]\nadapter = "custom"\n')).message).toContain('cache.module is required for adapter "custom"')
})

test('an unknown adapter lists the five names', async () => {
  const e = await err('[cache]\nadapter = "memcached"\n')
  for (const n of ['redis', 'dragonfly', 'cloudflare-kv', 'cloudflare-do', 'custom']) expect(e.message).toContain(`"${n}"`)
})

test('range errors', async () => {
  const c = '[cache]\nadapter = "custom"\nmodule = "c.ts"\n'
  for (const v of [0, 1001]) expect((await err(`${c}get_timeout_ms = ${v}\n`)).message).toContain('cache.get_timeout_ms must be an integer in 1..1000')
  for (const v of [249, 60001]) expect((await err(`${c}epoch_interval_ms = ${v}\n`)).message).toContain('cache.epoch_interval_ms must be an integer in 250..60000')
  for (const v of [0, 67108865]) expect((await err(`${c}max_body_bytes = ${v}\n`)).message).toContain('cache.max_body_bytes must be an integer in 1..67108864')
})

test('an unknown key in [cache]', async () => {
  expect((await err('[cache]\nadapter = "custom"\nmodule = "c.ts"\nttl = 5\n')).message).toContain('cache.ttl is not a known key')
})

test('a literal redis url is refused without echoing it', async () => {
  const e = await err('[cache]\nadapter = "custom"\nmodule = "c.ts"\n[cache.redis]\nurl = "redis://u:p@h"\n')
  expect(e.message).toContain('cache.redis.url must be "env:NAME"')
  expect(e.message).not.toContain('u:p')
})

test('a built-in that is not installed gives the install hint', async () => {
  expect((await err('[cache]\nadapter = "redis"\n[cache.redis]\nurl = "env:REDIS_URL"\n')).message).toContain('adapter "redis" needs @brust/cache-redis (bun add @brust/cache-redis)')
  expect((await err('[cache]\nadapter = "custom"\nmodule = "c.ts"\nbroadcast = "cloudflare-do"\n')).message).toContain('@brust/cache-cloudflare')
  expect((await err('[cache]\nadapter = "custom"\nmodule = "c.ts"\nbroadcast = "custom"\n')).message).toContain('cache.broadcast must name a built-in')
})

// cache-redis R10: the `[cache.redis]` key list is checked at build, the same list the adapter checks at boot.
const REDIS = '[cache]\nadapter = "custom"\nmodule = "c.ts"\n[cache.redis]\nurl = "env:R"\n'

test('an unknown [cache.redis] key names it', async () => {
  expect((await err(`${REDIS}urll = "env:X"\n`)).message).toContain('cache.redis.urll is not a known key')
})

test('[cache.redis] range errors name the key', async () => {
  for (const [k, vs, range] of [
    ['connect_timeout_ms', [0, 60001], '100..60000'],
    ['max_body_bytes', [0, 67108865], '1..67108864'],
    ['marker_ttl_ms', [59999, 604800001], '60000..604800000'],
    ['unlink_batch', [0, 10001], '1..10000'],
    ['reconnect_min_ms', [9, 60001], '10..60000'],
  ] as const)
    for (const v of vs) expect((await err(`${REDIS}${k} = ${v}\n`)).message).toContain(`cache.redis.${k} must be an integer in ${range}`)
  expect((await err(`${REDIS}reconnect_min_ms = 500\nreconnect_max_ms = 100\n`)).message).toContain('reconnect_max_ms must be >= cache.redis.reconnect_min_ms')
})

test('[cache.redis] tls forms', async () => {
  expect((await err(`${REDIS}tls = "yes"\n`)).message).toContain('cache.redis.tls must be a boolean or a table')
  expect((await err(`${REDIS}tls = { cert = "x" }\n`)).message).toContain('cache.redis.tls.cert is not a known key')
  expect((await err(`${REDIS}tls = { ca_file = 1 }\n`)).message).toContain('cache.redis.tls.ca_file must be a non-empty string')
})

test('every [cache.redis] key valid → passes and reaches manifest.cache.options unchanged', async () => {
  const app = tmpApp(
    '[cache]\nadapter = "redis"\n[cache.redis]\nurl = "env:R"\ntls = { reject_unauthorized = false, server_name = "x", ca_file = "ca.pem" }\nconnect_timeout_ms = 100\nmax_body_bytes = 1\nmarker_ttl_ms = 60000\nunlink_batch = 10000\nreconnect_min_ms = 10\nreconnect_max_ms = 600000\n',
  )
  // The built-in must resolve from the app root: a stub package stands in for @brust/cache-redis.
  const pkg = join(app, 'node_modules/@brust/cache-redis')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), '{"name":"@brust/cache-redis","version":"0.0.0","main":"index.js"}')
  writeFileSync(join(pkg, 'index.js'), 'module.exports = {}')
  const c = (await loadBuildConfig(app)).cache!
  expect(c.options).toEqual({
    url: 'env:R',
    tls: { reject_unauthorized: false, server_name: 'x', ca_file: 'ca.pem' },
    connect_timeout_ms: 100,
    max_body_bytes: 1,
    marker_ttl_ms: 60000,
    unlink_batch: 10000,
    reconnect_min_ms: 10,
    reconnect_max_ms: 600000,
  })
})
