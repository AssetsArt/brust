// cache-redis (lane B) Task 7: two `brust start` processes share one Redis / Dragonfly through
// @brust/cache-redis. Env-gated like the package suites: BRUST_REDIS_URL / BRUST_DRAGONFLY_URL
// (BRUST_REDIS_REQUIRED=1 turns a missing URL into a failure). Kills only the PIDs it spawned.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RedisClient } from 'bun'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../fixtures/l2-redis')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const spawned: ReturnType<typeof Bun.spawn>[] = []
const NS = 'l2redis'

function servers(): [string, string][] {
  const want: [string, string, string][] = [
    ['redis', 'BRUST_REDIS_URL', process.env.BRUST_REDIS_URL ?? ''],
    ['dragonfly', 'BRUST_DRAGONFLY_URL', process.env.BRUST_DRAGONFLY_URL ?? ''],
  ]
  const missing = want.filter((w) => !w[2]).map((w) => w[1])
  if (missing.length && process.env.BRUST_REDIS_REQUIRED === '1') throw new Error(`BRUST_REDIS_REQUIRED=1 but ${missing.join(' and ')} not set`)
  return want.filter((w) => w[2]).map((w) => [w[0], w[2]])
}

async function readUntil(proc: ReturnType<typeof Bun.spawn>, re: RegExp): Promise<{ match: RegExpExecArray; log: () => string }> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  let m: RegExpExecArray | null = null
  while (!(m = re.exec(out))) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`exited before ${re}:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      out += dec.decode(value, { stream: true })
    }
  })()
  return { match: m, log: () => out }
}

type Srv = { base: string; get: (p: string) => Promise<Response>; l2: () => Promise<Record<string, number | string>>; stats: () => Promise<Record<string, unknown>> }

async function boot(redisUrl: string): Promise<Srv> {
  // `bun test` sets NODE_ENV=test; a real `brust start` is production.
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production', BRUST_E2E_REDIS_URL: redisUrl }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  spawned.push(proc)
  const r = await readUntil(proc, /\[brust\] ready/)
  const base = `http://${/listening on (\S+)/.exec(r.log())![1]}`
  const stats = async () => (await (await fetch(`${base}/_brust/cache/stats`)).json()) as Record<string, unknown>
  return { base, get: (p) => fetch(base + p), stats, l2: async () => (await stats()).l2 as Record<string, number | string> }
}

const nOf = async (r: Response) => Number(/class="n">(\d+)</.exec(await r.text())![1])
async function poll<T>(what: string, f: () => Promise<T | undefined>, ms = 2000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await f()
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await Bun.sleep(25)
  }
}

async function scan(c: RedisClient, pattern: string): Promise<string[]> {
  const all: string[] = []
  let cursor = '0'
  do {
    const [next, ks] = (await c.send('SCAN', [cursor, 'MATCH', pattern, 'COUNT', '1000'])) as [string, string[]]
    cursor = next
    all.push(...ks)
  } while (cursor !== '0')
  return all
}

// The fixture's brust.toml names `redis`; a Dragonfly run builds with `adapter = "dragonfly"` (the one
// line that differs) and puts the committed file back afterwards.
const tomlPath = join(app, 'brust.toml')
const tomlOriginal = readFileSync(tomlPath, 'utf8')
function build(flavor: string) {
  writeFileSync(tomlPath, tomlOriginal.replace('adapter = "redis"', `adapter = "${flavor}"`))
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
}

afterAll(async () => {
  writeFileSync(tomlPath, tomlOriginal)
  for (const p of spawned.reverse()) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      p.kill('SIGKILL')
      await p.exited
    }
  }
})

for (const [flavor, url] of servers()) {
  describe(`cache-redis e2e (${flavor})`, () => {
    let A: Srv
    let B: Srv
    let redis: RedisClient
    let firstN = 0
    const seqKey = `{brust:${NS}}:seq`

    beforeAll(async () => {
      redis = new RedisClient(url)
      const stale = await scan(redis, `{brust:${NS}}:*`)
      if (stale.length) await redis.unlink(...stale)
      build(flavor)
      ;[A, B] = await Promise.all([boot(url), boot(url)])
    }, 120_000)

    afterAll(async () => {
      const left = await scan(redis, `{brust:${NS}}:*`)
      if (left.length) await redis.unlink(...left)
      redis.close()
    })

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
      const l2 = s.l2 as Record<string, number | string>
      expect(l2.adapter).toBe(flavor)
      expect(l2.hits as number).toBeGreaterThanOrEqual(1)
      expect(s.loader_calls).toBe(0)
    })

    test('2 an invalidation on A reaches B; seq moves once (L3: B does not re-publish)', async () => {
      const s0 = Number((await redis.get(seqKey)) ?? 0)
      const r = await fetch(`${A.base}/_brust/action/bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tag":"items"}' })
      expect(r.status).toBe(200)
      await r.text()
      await poll('fresh on B', async () => {
        const res = await B.get('/items/7')
        return (await nOf(res)) > firstN ? true : undefined
      }, 1000)
      await Bun.sleep(500)
      expect(Number(await redis.get(seqKey))).toBe(s0 + 1)
      expect((await B.l2()).received as number).toBeGreaterThanOrEqual(1)
      expect((await A.l2()).skipped_own as number).toBeGreaterThanOrEqual(1)
      console.log(`[${flavor}] B stats.l2 ${JSON.stringify(await B.l2())}`)
    })

    test('3 an uncached route never touches the store', async () => {
      const before = (await scan(redis, `{brust:${NS}}:page:*`)).length
      const r = await A.get('/plain/1')
      expect(r.status).toBe(200)
      await r.text()
      expect((await scan(redis, `{brust:${NS}}:page:*`)).length).toBe(before)
    })

    test('4 fail-open: with the server unreachable pages still render', async () => {
      const C = await boot('redis://127.0.0.1:1')
      const t0 = Date.now()
      const r = await C.get('/items/9')
      expect(r.status).toBe(200)
      await r.text()
      expect(Date.now() - t0).toBeLessThan(2000)
      const l2 = await C.l2()
      expect((l2.errors as number) + (l2.timeouts as number)).toBeGreaterThanOrEqual(1)
    })

    test('5 the subscriber reconnects: an invalidation after CLIENT KILL TYPE pubsub still reaches B', async () => {
      try {
        await redis.send('CLIENT', ['KILL', 'TYPE', 'pubsub'])
      } catch (e) {
        console.log(`[${flavor}] CLIENT KILL TYPE pubsub unsupported (${String(e)}): re-subscribe is covered by the package suite's dropSubscriber case`)
        return
      }
      // Both processes' worker-0 subscribers come back (the adapter's own loop, 100 ms backoff).
      await poll('both subscribers back', async () => ((await redis.send('PUBSUB', ['NUMSUB', `brust:${NS}:inval`])) as [string, number])[1] >= 2 ? true : undefined, 3000)
      const warm = await B.get('/items/7')
      await warm.text()
      const fresh0 = await nOf(await B.get('/items/7'))
      const r = await fetch(`${A.base}/_brust/action/bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tag":"items"}' })
      expect(r.status).toBe(200)
      await r.text()
      await poll('fresh on B after the re-subscribe', async () => ((await nOf(await B.get('/items/7'))) > fresh0 ? true : undefined), 2000)
    })
  })
}
