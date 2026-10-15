// cache-adapter lane A, Task 10: two `brust start` processes share one cache adapter (a relay-hosted
// memory adapter, tests/server/l2-relay.ts). Kills only the PIDs it spawned.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'

const app = join(import.meta.dir, '../fixtures/l2-relay')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const spawned: ReturnType<typeof Bun.spawn>[] = []

// Waits until EVERY pattern matched the output so far (in any order), and returns the first pattern's match. A boot prints
// `[brust] listening on` (Rust, after the workers registered) and `[brust] ready` (JS, after `untilReady` saw the same
// registrations): two threads, so either line can come first (F128). On a dead process the error carries the whole log.
async function readUntil(proc: ReturnType<typeof Bun.spawn>, ...res: RegExp[]): Promise<{ match: RegExpExecArray; log: () => string }> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  let m: RegExpExecArray | null = null
  while (!res.every((re) => re.test(out))) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`exited before ${res.join(' and ')} (pid ${proc.pid}); output so far:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  m = res[0]!.exec(out)!
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      out += dec.decode(value, { stream: true })
    }
  })()
  return { match: m, log: () => out }
}

let relay: ReturnType<typeof Bun.spawn>
let relayUrl = ''
type Srv = { base: string; get: (p: string) => Promise<Response>; l2: () => Promise<Record<string, number>>; stats: () => Promise<Record<string, unknown>> }
let A: Srv
let B: Srv

async function boot(): Promise<Srv> {
  // `bun test` sets NODE_ENV=test; a real `brust start` is production.
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production', BRUST_L2_RELAY: relayUrl }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  spawned.push(proc)
  const r = await readUntil(proc, /listening on (\S+)/, /\[brust\] ready/)
  const base = `http://${r.match[1]}`
  const stats = async () => (await (await fetch(`${base}/_brust/cache/stats`)).json()) as Record<string, unknown>
  return { base, get: (p) => fetch(base + p), stats, l2: async () => (await stats()).l2 as Record<string, number> }
}


const relayStats = async () => (await (await fetch(`${relayUrl}/stats`)).json()) as { publishCount: number; gets: number; size: number }
const nOf = async (r: Response) => Number(/class="n">(\d+)</.exec(await r.text())![1])
async function poll<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  // The bound only ends a hang: a poll returns the moment its event happens, so a long bound costs nothing on success (F203).
  const t0 = Date.now()
  for (;;) {
    const v = await f()
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await Bun.sleep(25)
  }
}

beforeAll(async () => {
  relay = Bun.spawn(['bun', join(import.meta.dir, 'l2-relay.ts')], { stdout: 'pipe', stderr: 'inherit' })
  spawned.push(relay)
  relayUrl = `http://127.0.0.1:${(await readUntil(relay, /listening (\d+)/)).match[1]}`
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  ;[A, B] = await Promise.all([boot(), boot()])
}, 120_000)

afterAll(async () => {
  for (const p of spawned.reverse()) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      p.kill('SIGKILL')
      await p.exited
    }
  }
})

let firstN = 0

test('1 a MISS on A is a HIT-L2 on B (no loader), then a HIT', async () => {
  const a = await A.get('/items/7')
  expect(a.headers.get('x-brust-cache')).toBe('MISS')
  firstN = await nOf(a)
  const b = await poll('HIT-L2 on B', async () => {
    const r = await B.get('/items/7')
    if (r.headers.get('x-brust-cache') === 'HIT-L2') return r
    await r.text()
    return undefined
  })
  expect(await nOf(b)).toBe(firstN)
  const again = await B.get('/items/7')
  expect(again.headers.get('x-brust-cache')).toBe('HIT')
  await again.text()
  const s = await B.stats()
  expect((s.l2 as Record<string, number>).hits).toBeGreaterThanOrEqual(1)
  expect(s.loader_calls).toBe(0)
})

test('2 an invalidation on A reaches B; B does not re-publish (L3)', async () => {
  const before = (await relayStats()).publishCount
  const r = await fetch(`${A.base}/_brust/action/bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tag":"items"}' })
  expect(r.status).toBe(200)
  await r.text()
  await poll('publish', async () => ((await relayStats()).publishCount === before + 1 ? true : undefined))
  await poll('fresh on B', async () => {
    const res = await B.get('/items/7')
    return (await nOf(res)) > firstN ? true : undefined
  })
  await Bun.sleep(500) // an absence check (no re-publish): a longer wait only makes it stricter, never flakier
  expect((await relayStats()).publishCount).toBe(before + 1)
  expect((await B.l2()).received).toBeGreaterThanOrEqual(1)
  expect((await A.l2()).skipped_own).toBeGreaterThanOrEqual(1)
})

test('3 an uncached route never calls the adapter', async () => {
  const before = (await relayStats()).gets
  const r = await A.get('/plain/1')
  expect(r.status).toBe(200)
  await r.text()
  expect((await relayStats()).gets).toBe(before)
})

test('4 a hung get renders within the budget', async () => {
  await fetch(`${relayUrl}/hang-next-get`, { method: 'POST', body: '{}' })
  const t0 = Date.now()
  const r = await B.get('/items/8')
  expect(r.status).toBe(200)
  expect(r.headers.get('x-brust-cache')).toBe('MISS')
  await r.text()
  // The relay hangs this get for 3000 ms: a render that waited for it would take at least that long. `l2.timeouts` below
  // is the deterministic proof; this bound is the hang length, not a few hundred ms a loaded runner can exceed.
  expect(Date.now() - t0).toBeLessThan(3000)
  const l2 = await B.l2()
  expect(l2.timeouts).toBe(1)
  console.log(`B stats.l2 ${JSON.stringify(l2)}`)
})

test('4b F1: a stale L2 body re-filled on the origin before its delete landed is dropped by its own replay', async () => {
  const size = (await relayStats()).size
  const warm = await A.get('/items/10')
  expect(warm.headers.get('x-brust-cache')).toBe('MISS')
  const old = await nOf(warm)
  await poll('the write-through', async () => ((await relayStats()).size > size ? true : undefined))
  const published = (await relayStats()).publishCount
  await fetch(`${relayUrl}/delay-next-invalidate`, { method: 'POST', body: '{"ms":1000}' })
  const r = await fetch(`${A.base}/_brust/action/bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tag":"items"}' })
  expect(r.status).toBe(200)
  await r.text()
  // Inside the window: tier 1 is cleared but the shared store still holds the old body.
  const stale = await A.get('/items/10')
  expect(stale.headers.get('x-brust-cache')).toBe('HIT-L2')
  expect(await nOf(stale)).toBe(old)
  await poll('the publish', async () => ((await relayStats()).publishCount === published + 1 ? true : undefined))
  // The invalidation reaches A after the publish: poll for the first MISS instead of sleeping and hoping.
  const fresh = await poll('the invalidation on A', async () => {
    const res = await A.get('/items/10')
    return res.headers.get('x-brust-cache') === 'MISS' ? res : undefined
  })
  expect(await nOf(fresh)).toBeGreaterThan(old)
})

test('5 with the relay gone, pages still render (fail-open)', async () => {
  relay.kill('SIGKILL')
  await relay.exited
  const r = await A.get('/items/9')
  expect(r.status).toBe(200)
  await r.text()
  const l2 = await A.l2()
  expect(l2.errors + l2.timeouts).toBeGreaterThanOrEqual(1)
})
