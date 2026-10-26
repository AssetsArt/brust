// F465: a cross-site HTML form POST to an action answers the documented 403 `CrossSiteRejected` problem+json (before
// the body is read and without calling the worker), whatever the form encoding; a same-origin form post is admitted.
// Real Chromium: a page on one origin (localhost:<a>) submits a <form> to the action on another (127.0.0.1:<b>), against
// packages/brust/test/fixtures/cross-site-form served by `brust start` with `[actions] prefix = "/auth"`.
// Run alone: `bun test --timeout 180000 tests/server/cross-site-form.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/cross-site-form')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let api = '' // http://127.0.0.1:<b>: the action's origin
let foreign: ReturnType<typeof Bun.serve>
let foreignBase = '' // http://localhost:<a>: the page that holds the form
let browser: Browser

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log) || !/listening on (\S+)/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  api = `http://${/listening on (\S+)/.exec(log)![1]}`
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  // The foreign page: one form per encoding, each posting to the action on the other origin.
  foreign = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        `<!doctype html><title>foreign</title>
<form id="urlencoded" method="post" action="${api}/auth/form"><input name="text" value="evil"><button>go</button></form>
<form id="multipart" method="post" enctype="multipart/form-data" action="${api}/auth/form"><input name="text" value="evil"><button>go</button></form>
<form id="plain" method="post" enctype="text/plain" action="${api}/auth/form"><input name="text" value="evil"><button>go</button></form>
<form id="empty" method="post" action="${api}/auth/form"><button>go</button></form>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
  })
  foreignBase = `http://localhost:${foreign.port}`
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  await browser?.close()
  await foreign?.stop(true)
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** What the action answered to the form submitted on `pageUrl`: the navigation response and the text it shows. */
async function submit(pageUrl: string, form: string) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(pageUrl)
  const [res] = await Promise.all([page.waitForNavigation({ waitUntil: 'commit' }), page.click(`${form} button`)])
  const status = res?.status() ?? 0
  const type = (await res?.headerValue('content-type')) ?? ''
  const text = (await res?.text().catch(() => '')) ?? ''
  await ctx.close()
  return { status, type, text }
}

const hits = async () => ((await (await fetch(`${api}/auth/hits`)).json()) as { hits: number }).hits

for (const form of ['urlencoded', 'multipart', 'plain', 'empty']) {
  test(`a cross-site ${form} form post answers the documented 403 and never reaches the worker`, async () => {
    const before = await hits()
    const r = await submit(foreignBase, `#${form}`)
    expect(r.status).toBe(403)
    expect(r.type).toContain('application/problem+json')
    expect(JSON.parse(r.text)).toMatchObject({ title: 'CrossSiteRejected', status: 403 })
    expect(await hits()).toBe(before)
  })
}

test('a same-origin form post is admitted', async () => {
  const before = await hits()
  const r = await submit(api, 'form')
  expect(r.status).toBe(200)
  expect(r.text).toBe('saved same-origin')
  expect(await hits()).toBe(before + 1)
})
