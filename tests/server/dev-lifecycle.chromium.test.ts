// tests/server/dev-lifecycle.chromium.test.ts — `brust dev` start/stop races (L13 review round 1): an edit saved while the FIRST
// build runs must win (no older build served as "ready"), and a stop during a boot must not orphan a `brust start`.
// Each test starts its own dev server. Run alone: `bun test --timeout 180000 tests/server/dev-lifecycle.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const host = join(import.meta.dir, '../fixtures/cf-min')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
}, 60_000)
afterAll(async () => {
  await browser?.close()
})

const page = (text: string) => `export default function Home() {
  return (
    <html lang="en"><head><meta charSet="utf-8" /><title>home</title></head><body><h1 data-testid="t">${text}</h1></body></html>
  )
}
`
/** `delayMs`: the FIRST worker that boots (a marker file outside the app says whether one already did) waits that long,
 * which keeps that child "booting" for a while; later boots are immediate. Build does not set BRUST_WORKER_ID. */
const routes = (delayMs: number, marker: string) => `import { existsSync, writeFileSync } from 'node:fs'
import { defineRoutes } from '@brust/core/routes'
import Home from './pages/Home'
if (process.env.BRUST_WORKER_ID !== undefined && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, '1')
  await new Promise((r) => setTimeout(r, ${delayMs}))
}
export const routes = defineRoutes([{ path: '/', Component: Home }])
`

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const p = s.port as number
  s.stop(true)
  return p
}

function startDev(firstBootDelayMs: number) {
  const app = mkdtempSync(join(host, '.devtest-'))
  const marker = join(tmpdir(), `brust-dev-boot-${process.pid}-${Date.now()}`)
  mkdirSync(join(app, 'pages'))
  writeFileSync(join(app, 'routes.tsx'), routes(firstBootDelayMs, marker))
  writeFileSync(join(app, 'pages/Home.tsx'), page('first'))
  const port = freePort()
  const proc = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], {
    cwd: app,
    env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'development', CI: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let log = ''
  for (const s of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const dec = new TextDecoder()
      for await (const c of s) log += dec.decode(c, { stream: true })
    })()
  }
  return {
    app,
    base: `http://localhost:${port}`,
    proc,
    log: () => log,
    write: (rel: string, s: string) => writeFileSync(join(app, rel), s),
    async stop() {
      if (proc.exitCode === null) {
        proc.kill('SIGINT')
        if ((await Promise.race([proc.exited, sleep(8000).then(() => undefined)])) === undefined) proc.kill('SIGKILL')
        await proc.exited
      }
      rmSync(app, { recursive: true, force: true })
      rmSync(marker, { force: true })
    },
  }
}

/** pids of `brust start` children of `ppid` (own process tree only). */
function startChildren(ppid: number): number[] {
  const r = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,command='])
  return r.stdout
    .toString()
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[2]) === ppid && /cli\.ts start --dist-dir/.test(m[3] ?? ''))
    .map((m) => Number(m[1]))
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('an edit saved while the FIRST build runs lands: the page shows it and keeps showing it (no older build wins)', async () => {
  const d = startDev(3000) // the first build's child boots slowly; the edit's child boots at once
  try {
    await sleep(250) // the first build/boot is in flight
    d.write('pages/Home.tsx', page('edited during the first build'))
    const p = await browser.newPage()
    const t0 = Date.now()
    let seen = ''
    for (;;) {
      await p.goto(`${d.base}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
      seen = (await p.locator('[data-testid="t"]').first().textContent({ timeout: 1000 }).catch(() => '')) ?? ''
      if (seen === 'edited during the first build') break
      if (Date.now() - t0 > 60_000) throw new Error(`never showed the edit (last: ${JSON.stringify(seen)})\n${d.log()}`)
      await sleep(300)
    }
    // Stable: no later swap brings the older build back, and the open page agrees with the server.
    await sleep(3000)
    expect(await p.locator('[data-testid="t"]').first().textContent()).toBe('edited during the first build')
    await p.reload({ waitUntil: 'domcontentloaded' })
    expect(await p.locator('[data-testid="t"]').first().textContent()).toBe('edited during the first build')
    const gens = [...d.log().matchAll(/\[brust\] ready \S+ gen (\d+)/g)].map((m) => Number(m[1]))
    expect(gens).toEqual([...gens].sort((a, b) => a - b)) // generations only go up
    await p.close()
  } finally {
    await d.stop()
  }
}, 120_000)

test('SIGTERM while a child is booting leaves no orphaned `brust start`', async () => {
  const d = startDev(30_000)
  try {
    let kids: number[] = []
    const t0 = Date.now()
    while (kids.length === 0) {
      kids = startChildren(d.proc.pid)
      if (Date.now() - t0 > 60_000) throw new Error(`no booting child appeared\n${d.log()}`)
      await sleep(20)
    }
    expect(d.log()).not.toMatch(/\[brust\] ready/) // it is still booting
    d.proc.kill('SIGTERM')
    expect(await Promise.race([d.proc.exited, sleep(20_000).then(() => 'timeout')])).toBe(0)
    const t1 = Date.now()
    while (kids.some(alive)) {
      if (Date.now() - t1 > 2500) throw new Error(`orphaned brust start: ${kids.filter(alive)}`)
      await sleep(100)
    }
  } finally {
    await d.stop()
  }
}, 120_000)
