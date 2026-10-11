// M3-F S9: builds the store-app fixture with the real CLI, starts it with two Bun workers and checks the
// store snapshot from the outside: data-brust-store tags, the L1 cache, the ssr job key.
// Run on its own: `bun test --timeout 120000 test/e2e-store.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/store-app')
const bin = join(import.meta.dir, '../bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let stdout = ''

type Stats = { loader_calls: number; job_calls: number; worker_calls: number }
const stats = async (): Promise<Stats> => (await fetch(`${base}/_brust/cache/stats`)).json() as Promise<Stats>
const TAG = 'data-brust-store'
const RUNTIME = '<script type="module" src="/_brust/client/runtime-'

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  while (!/\[brust\] ready/.test(stdout)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${stdout}`)
    stdout += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(stdout)![1]}`
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      stdout += dec.decode(value, { stream: true })
    }
  })()
}, 120_000)

afterAll(async () => {
  try {
    if (proc) await stop(proc)
  } finally {
    rmSync(join(app, 'dist'), { recursive: true, force: true })
  }
})

async function stop(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill('SIGINT')
  const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])
  if (exited === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
}

const tagsOf = (html: string) => [...html.matchAll(/<script type="application\/json" data-brust-store="([^"]+)">([^<]*)<\/script>/g)]

test('static route and a loader route touching no store carry no store tag, no loader call for /', async () => {
  const before = await stats()
  const home = await fetch(`${base}/`)
  expect(home.status).toBe(200)
  expect(await home.text()).not.toContain(TAG)
  expect((await stats()).loader_calls).toBe(before.loader_calls)
  const plain = await fetch(`${base}/plain`)
  expect(plain.status).toBe(200)
  expect(await plain.text()).not.toContain(TAG)
  expect((await stats()).loader_calls - before.loader_calls).toBe(1)
})

test('/cart: one cart tag right before the runtime script; second request is an L1 HIT, same body', async () => {
  const before = await stats()
  const r1 = await fetch(`${base}/cart`)
  const h1 = await r1.text()
  expect(r1.status).toBe(200)
  expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  expect(h1.split(TAG)).toHaveLength(2)
  const tag = `<script type="application/json" ${TAG}="cart">{"count":3}</script>`
  expect(h1).toContain(tag)
  expect(h1.indexOf(tag) + tag.length).toBe(h1.indexOf(RUNTIME))
  const s1 = await stats()
  expect(s1.loader_calls - before.loader_calls).toBe(1)

  const r2 = await fetch(`${base}/cart`)
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  expect(await r2.text()).toBe(h1)
  expect((await stats()).loader_calls).toBe(s1.loader_calls)
})

test('/both: cart then user tags', async () => {
  const h = await (await fetch(`${base}/both`)).text()
  expect(tagsOf(h).map((m) => m[1])).toEqual(['cart', 'user'])
  expect(tagsOf(h).map((m) => JSON.parse(m[2]!))).toEqual([{ count: 1 }, { label: 'ann' }])
})

test('/island: ssr job runs; the job key follows the store value (?n=6 twice -> one job, ?n=7 -> another)', async () => {
  const s0 = await stats()
  const h6 = await (await fetch(`${base}/island?n=6`)).text()
  const host = /<brust-island[^>]*>(.*?)<\/brust-island>/s.exec(h6)
  expect(host?.[1]).toBeTruthy()
  const s1 = await stats()
  expect(s1.job_calls - s0.job_calls).toBe(1)
  expect(s1.loader_calls - s0.loader_calls).toBe(1)
  await fetch(`${base}/island?n=6`)
  const s2 = await stats()
  expect(s2.job_calls).toBe(s1.job_calls)
  const h7 = await (await fetch(`${base}/island?n=7`)).text()
  expect(h7).not.toBe(h6)
  const s3 = await stats()
  expect(s3.job_calls - s2.job_calls).toBe(1)
  expect(s3.loader_calls - s2.loader_calls).toBe(1)
})
