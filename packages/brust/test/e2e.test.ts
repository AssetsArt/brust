// Builds the fixture app with the real CLI, starts it with two Bun workers and asserts every S7
// behaviour from the outside (plan D4 / Review Focus 1 + 5). Run on its own:
// `bun test --timeout 120000 test/e2e.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/app')
const bin = join(import.meta.dir, '../bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let stdout = ''

type Stats = { loader_calls: number; job_calls: number }
const stats = async (): Promise<Stats> => (await fetch(`${base}/_brust/cache/stats`)).json() as Promise<Stats>

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  // "[brust] listening on 127.0.0.1:NNNN (io: hyper(tokio))" (brust-server server/mod.rs), then
  // "[brust] ready (2 workers)" once every worker registered (run.ts). Keep draining stdout
  // afterwards: a closed pipe would make the server's next println! panic.
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  while (!/\[brust\] ready/.test(stdout)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${stdout}`)
    stdout += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(stdout)![1]}`
  expect(stdout).toContain('[brust] ready (2 workers)')
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

test('static route: 200, layout composed, zero Bun calls, only the layout runtime scripts', async () => {
  const r = await fetch(`${base}/`)
  const html = await r.text()
  expect(r.status).toBe(200)
  expect(html).toMatch(/<main>\s*<section><h1>Home<\/h1><\/section><\/main>/)
  // HomePage is static: no chunk, no island. The only scripts are the native layout's (useState):
  // the runtime and the layout chunk (contract 6) — they load in the browser, not in Bun.
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])
  expect(scripts).toHaveLength(2)
  expect(scripts[0]).toMatch(/^\/_brust\/client\/runtime-[0-9a-f]{10}\.js$/)
  expect(scripts[1]).toMatch(/^\/_brust\/client\/appLayout_[0-9a-f]{8}-[0-9a-f]{10}\.js$/)
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('brust-island')
  expect(await stats()).toMatchObject({ loader_calls: 0, job_calls: 0 })
})

test('loader route: per-row values, useId, island SSR + chunk; second request is a HIT without Bun', async () => {
  const before = await stats()
  const r1 = await fetch(`${base}/items/7`)
  const h1 = await r1.text()
  expect(r1.status).toBe(200)
  expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  expect(h1).toContain('<h1 id="brust-r2-itemPage_b7278c7c-1">Item 7</h1>') // useId allocated by the server; ItemPage is static (F70)
  expect(h1).toContain('<p class="total">12.5€</p>')
  // Per-row child job values painted per row, in row order (Review Focus 1).
  expect(h1).toMatch(/<li>1\.0€<\/li>.*<li>2\.3€<\/li>/s) // plain rows (F70)
  // React island SSR'd by a worker, the literal `title="crew"` merged from the manifest.
  expect(h1).toMatch(
    /<brust-island data-id="team_[0-9a-f]{8}" x-props='[^']*'><div class="team"><h3>crew<\/h3><button>\+<!-- -->0<\/button><span>ann<\/span><span>bob<\/span><\/div><\/brust-island>/,
  )
  expect(h1).toMatch(/<script type="module" src="\/_brust\/client\/react-team_[0-9a-f]{8}-[0-9a-f]{10}\.js"><\/script>/)
  const s1 = await stats()
  expect(s1.loader_calls - before.loader_calls).toBe(1)
  expect(s1.job_calls - before.job_calls).toBe(1)

  const r2 = await fetch(`${base}/items/7`)
  const h2 = await r2.text()
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  expect(h2).toBe(h1) // same useId values, same HTML
  expect(await stats()).toMatchObject({ loader_calls: s1.loader_calls, job_calls: s1.job_calls })

  const src = /src="(\/_brust\/client\/react-[^"]+)"/.exec(h1)![1]
  const chunk = await fetch(`${base}${src}`)
  expect(chunk.status).toBe(200)
  expect(chunk.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(await chunk.text()).toContain('__brustIslands')
})

test('notFound verdict renders the route template at 404 and is not cached', async () => {
  const r = await fetch(`${base}/items/nothing`)
  expect(r.status).toBe(404)
  expect(await r.text()).toContain('<h1 id="brust-r2-itemPage_b7278c7c-1">missing</h1>')
  const again = await fetch(`${base}/items/nothing`)
  expect(again.status).toBe(404)
  expect(again.headers.get('x-brust-cache')).toBe('MISS')
})

test('unknown path is 404; public files are served', async () => {
  expect((await fetch(`${base}/nope`)).status).toBe(404)
  const css = await fetch(`${base}/public/app.css`)
  expect(css.status).toBe(200)
  expect((await css.text()).trim()).toBe('body{margin:0}')
})
