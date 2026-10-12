// cache-adapter lane A, Task 11: a pull-broadcast memory adapter inside the cf-l2 Worker under local
// workerd — read-through, replay of another isolate's events (never re-published, L3), the floor,
// the own echo, and a hung get. Opt-in: BRUST_CF_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { WRANGLER } from './tools'

const ENABLED = process.env.BRUST_CF_E2E === '1'
const APP = resolve(import.meta.dir, '../fixtures/cf-l2')
const CF = join(APP, 'dist/cf')
const OUT = join(process.env.BRUST_CF_OUT ?? '/tmp/m4cf-worker-crate', 'cf-l2')
const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

let base = ''
let dev: ReturnType<typeof Bun.spawn> | undefined
let log = ''

const get = (path: string, init?: RequestInit) => fetch(base + path, { redirect: 'manual', ...init })
type L2 = Record<string, number>
const S = async () => (await (await get('/_brust/cache/stats')).json()) as { loader_calls: number; l2: L2 }
const post = (path: string, body: unknown) =>
  get(`/_brust/action${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const state = async () => (await (await get('/_brust/action/e2e/state')).json()) as { publishCount: number; seq: number; size: number }
const l1Clear = async () => expect((await get('/__brust_e2e/l1-clear')).status).toBe(204)
async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await f()
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await Bun.sleep(50)
  }
}
const rOf = (html: string) => Number(/class="r">(\d+)</.exec(html)?.[1])
/** The interval is 250 ms: a sleep of 300 ms is only a lower bound for the next poll. */
const nextPoll = () => Bun.sleep(300)

describe.skipIf(!ENABLED)('cf-l2: a cache adapter on local workerd', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    const build = Bun.spawnSync(['bun', join(APP, 'scripts/build-cf.ts')], { cwd: APP, stdout: 'inherit', stderr: 'inherit' })
    if (build.exitCode !== 0) throw new Error(`build-cf exited ${build.exitCode}`)

    const dry = Bun.spawnSync(
      ['bunx', WRANGLER, 'deploy', '--dry-run', '--outdir', join(OUT, 'bundle'), '-c', join(CF, 'wrangler.jsonc')],
      { cwd: CF, env: ENV },
    )
    const dryOut = dry.stdout.toString() + dry.stderr.toString()
    writeFileSync(join(OUT, 'dry-run.txt'), dryOut)
    if (dry.exitCode !== 0) throw new Error(`wrangler deploy --dry-run exited ${dry.exitCode}:\n${dryOut}`)
    console.log(dryOut.match(/Total Upload:.*/)?.[0] ?? 'no Total Upload line')

    const [port, inspector] = [await freePort(), await freePort()]
    dev = Bun.spawn(
      [
        'bunx',
        WRANGLER,
        'dev',
        '--port',
        String(port),
        '--ip',
        '127.0.0.1',
        '--inspector-port',
        String(inspector),
        '--persist-to',
        join(OUT, 'state'),
        '--show-interactive-dev-session=false',
      ],
      { cwd: CF, env: ENV, stdout: 'pipe', stderr: 'pipe' },
    )
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const d = new TextDecoder()
      for await (const chunk of s) log += d.decode(chunk)
    }
    void pump(dev.stdout as ReadableStream<Uint8Array>)
    void pump(dev.stderr as ReadableStream<Uint8Array>)
    const deadline = Date.now() + 120_000
    while (!/Ready on/.test(log)) {
      if (Date.now() > deadline || dev.exitCode !== null) throw new Error(`wrangler dev not ready:\n${log}`)
      await Bun.sleep(250)
    }
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    writeFileSync(join(OUT, 'wrangler-dev.log'), log)
    if (!dev) return
    dev.kill('SIGINT')
    const killed = await Promise.race([dev.exited.then(() => true), Bun.sleep(5000).then(() => false)])
    if (!killed) dev.kill('SIGKILL')
    await dev.exited
    expect(await get('/').then(() => 'open', () => 'refused')).toBe('refused')
  })

  test('1 MISS, then (L1 cleared) HIT-L2 with the same body and no loader, then HIT', async () => {
    const a = await get('/items/7')
    expect(a.headers.get('x-brust-cache')).toBe('MISS')
    const html = await a.text()
    await until('the write-through', async () => ((await state()).size >= 1 ? true : undefined))
    const loaders = (await S()).loader_calls
    await l1Clear()
    const b = await get('/items/7')
    expect(b.headers.get('x-brust-cache')).toBe('HIT-L2')
    expect(await b.text()).toBe(html)
    expect((await S()).loader_calls).toBe(loaders)
    const c = await get('/items/7')
    expect(c.headers.get('x-brust-cache')).toBe('HIT')
    await c.text()
  })

  test("2 another isolate's invalidation is replayed here and never re-published (L3)", async () => {
    const before = await S()
    const r = await post('/e2e/remote', { args: { tags: ['items'] } })
    expect(r.status).toBe(200)
    await r.text()
    const published = (await state()).publishCount
    await nextPoll()
    const m = await get('/items/7')
    expect(m.headers.get('x-brust-cache')).toBe('MISS')
    await m.text()
    const after = await S()
    expect(after.l2.received).toBe(before.l2.received + 1)
    await nextPoll()
    await (await get('/items/7')).text()
    expect((await state()).publishCount).toBe(published)
  })

  test('3 an event whose store delete has not landed: the floor rejects the old body', async () => {
    await until('the write-through', async () => ((await state()).size >= 1 ? true : undefined))
    const warm = await get('/items/7')
    await warm.text()
    await l1Clear()
    const before = (await S()).l2.rejected_floor
    await (await post('/e2e/remote-publish-only', { args: { tags: ['items'] } })).text()
    await nextPoll()
    const r = await get('/items/7')
    expect(r.headers.get('x-brust-cache')).not.toBe('HIT-L2')
    await r.text()
    expect((await S()).l2.rejected_floor).toBe(before + 1)
  })

  test("4 this isolate's own invalidation is published once and its echo is skipped", async () => {
    const { publishCount } = await state()
    const own = (await S()).l2.skipped_own
    const r = await post('/bump', { tag: 'items' })
    expect(r.status).toBe(200)
    await r.text()
    await until('the publish', async () => ((await state()).publishCount === publishCount + 1 ? true : undefined))
    await (await get('/items/7')).text()
    await nextPoll()
    await (await get('/items/7')).text()
    await nextPoll()
    const h = await get('/items/7')
    expect(h.headers.get('x-brust-cache')).toBe('HIT')
    await h.text()
    expect((await S()).l2.skipped_own).toBe(own + 1)
    expect((await state()).publishCount).toBe(publishCount + 1)
  })

  test('5 a hung get renders within the budget', async () => {
    const before = (await S()).l2.timeouts
    await (await post('/e2e/hang-next-get', {})).text()
    await l1Clear()
    const t0 = Date.now()
    const r = await get('/items/8', { signal: AbortSignal.timeout(5000) })
    expect(r.status).toBe(200)
    await r.text()
    expect(Date.now() - t0).toBeLessThan(5000)
    const l2 = (await S()).l2
    expect(l2.timeouts).toBe(before + 1)
    writeFileSync(join(OUT, 'l2-stats.json'), JSON.stringify(l2))
  })

  test('6 F1: a stale body re-filled in the isolate before its delete landed is dropped by its own replay', async () => {
    const { size } = await state()
    const warm = await get('/items/9')
    expect(warm.headers.get('x-brust-cache')).toBe('MISS')
    const old = rOf(await warm.text())
    await until('the write-through', async () => ((await state()).size > size ? true : undefined))
    const { publishCount } = await state()
    await (await post('/e2e/delay-next-invalidate', {})).text()
    const r = await post('/bump', { tag: 'items' })
    expect(r.status).toBe(200)
    await r.text()
    const stale = await get('/items/9')
    expect(stale.headers.get('x-brust-cache')).toBe('HIT-L2')
    expect(rOf(await stale.text())).toBe(old)
    await until('the publish', async () => ((await state()).publishCount === publishCount + 1 ? true : undefined))
    await nextPoll()
    const fresh = await get('/items/9')
    expect(fresh.headers.get('x-brust-cache')).toBe('MISS')
    expect(rOf(await fresh.text())).toBeGreaterThan(old)
  })
})
