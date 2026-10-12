// Lane A's conformance suite against the Cloudflare adapters under local workerd (opt-in: BRUST_CF_E2E=1).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runConformance } from '../../packages/brust/src/cache-adapter/conformance'
import { startWrangler, type Wrangler } from './pokedex-d1/remote'
import { call, hook, type Kind, proxyAdapter } from './cache-cloudflare/proxy'

const ENABLED = process.env.BRUST_CF_E2E === '1'
const CONFIG = join(import.meta.dir, 'cache-cloudflare', 'wrangler.jsonc')
let state = ''
let w: Wrangler
const base = () => w.base

describe.skipIf(!ENABLED)('@brust/cache-cloudflare on local workerd', () => {
  beforeAll(async () => {
    state = mkdtempSync(join(tmpdir(), 'cache-cf-conf-'))
    w = await startWrangler({ config: CONFIG, state })
  }, 180_000)
  afterAll(async () => {
    await w?.stop()
    rmSync(state, { recursive: true, force: true })
  })
  const make = (kind: Kind) => () => proxyAdapter(base(), kind, crypto.randomUUID())

  describe('kv alone (no guard, no invalidation: R5)', () => runConformance(make('kv'), { guard: false, invalidate: false }))
  describe('do (store + pull broadcast)', () => runConformance(make('do'), { pull: true, guard: true }))
  describe('kv + do (combine)', () => runConformance(make('kvdo'), { pull: true, guard: true }))

  describe('SQL paths', () => {
    const page = (n: number) => ({ status: 200, headers: [] as [string, string][], body: new Uint8Array(n) })
    const meta = { ttlMs: 60_000, tags: [], method: 'GET', path: '/', stamp: null }
    test('a DO-store row over 1_900_000 bytes is refused', async () => {
      const a = proxyAdapter(base(), 'do', crypto.randomUUID())
      await a.init!({ namespace: 'x', buildId: 'b', runtime: 'workers', workerId: 0 })
      expect(await a.store!.set('big:0', page(1_900_001), meta)).toBe(false)
      expect(await a.store!.set('ok:0', page(1_000_000), meta)).toBe(true)
      expect((await a.store!.get('ok:0')).page!.body.length).toBe(1_000_000)
    }, 60_000)
    test('__regen: a new gen and a seq that never regresses (R7)', async () => {
      const ns = crypto.randomUUID()
      const a = proxyAdapter(base(), 'do', ns)
      await a.init!({ namespace: ns, buildId: 'b', runtime: 'workers', workerId: 0 })
      await a.broadcast!.publish({ tags: ['a'] }, 'o')
      const before = await a.broadcast!.since!(0)
      await hook(base(), 'epoch', ns, '__regen')
      const after = await a.broadcast!.since!(before.seq)
      expect(after.gen).not.toBe(before.gen)
      expect(after.seq).toBeGreaterThanOrEqual(before.seq)
      const next = await a.broadcast!.publish({ tags: ['b'] }, 'o')
      expect(next).toBeGreaterThan(before.seq)
    }, 60_000)
    test('expired rows are gone after the alarm sweep', async () => {
      const ns = crypto.randomUUID()
      const a = proxyAdapter(base(), 'do', ns)
      await a.init!({ namespace: ns, buildId: 'b', runtime: 'workers', workerId: 0 })
      expect(await a.store!.set('sweep:0', page(10), { ...meta, ttlMs: 50 })).toBe(true)
      expect((await hook(base(), 'shard', ns, '__state', 0)).pages).toBe(1)
      await Bun.sleep(150)
      await hook(base(), 'shard', ns, '__sweep', 0)
      expect((await hook(base(), 'shard', ns, '__state', 0)).pages).toBe(0)
    }, 60_000)
    test('the epoch survives a restart of the DO state: floors and seq persist', async () => {
      const ns = crypto.randomUUID()
      const a = proxyAdapter(base(), 'do', ns)
      await a.init!({ namespace: ns, buildId: 'b', runtime: 'workers', workerId: 0 })
      const s = await a.broadcast!.publish({ tags: ['persist'] }, 'o')
      expect((await hook(base(), 'epoch', ns, '__state')).seq).toBe(s)
      expect(await call(base(), 'kvdo', ns, 'adapter', 'init', { namespace: ns, buildId: 'b', runtime: 'workers', workerId: 0 })).toBeNull()
    }, 60_000)
  })
})
