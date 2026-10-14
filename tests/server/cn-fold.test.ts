// F149 (plan 2026-10-14-shadcn-cn-fold, R34.93/R34.95) on started servers: the 27 shadcn pages with an inlined instance
// that has a precompute job, built twice (class jobs folded at build, and BRUST_BUILD_EVAL=0, every instance a job).
// Each page is served byte-identically both ways; with the fold, the 18 pages whose only jobs were class jobs plan no
// job at all (the core's dev trace lists none), and alert, badge, button, card, table and label serve React's own markup
// with the real `cn` / `class-variance-authority` (alert: an omitted cva variant reaches the job as undefined, ruling
// 9b2a99a9). F183: `jobs.js` keeps only the jobs a route plans, and the 19 job-free pages alone build an app that
// starts no worker and serves them unchanged. Run alone: `bun test --timeout 300000 tests/server/cn-fold.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { reachedJobs } from '../../packages/brust/src/build/manifest'

const app = join(import.meta.dir, '../fixtures/shadcn')
const entry = 'cn-fold/routes.tsx'
const staticEntry = 'cn-fold/static-routes.tsx'
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const TOKEN = 'cn-fold-proof'

/** Every page of `cn-fold/routes.tsx`. */
const PAGES = ['alert', 'attachment', 'badge', 'badge-aslink', 'breadcrumb', 'bubble', 'button', 'button-aschild', 'button-group', 'card', 'checkbox', 'empty', 'field', 'input', 'input-group', 'item', 'kbd', 'label', 'marker', 'message', 'native-select', 'pagination', 'skeleton', 'sonner', 'switch', 'table', 'textarea']
/** The pages whose only jobs were class jobs (docs/plans/2026-10-14-shadcn-cn-fold.md §2), and `field`, whose fed Label
 * is fused into its parent's class job since R34.96 (PR 2b), so the build evaluates that one job too. */
const NO_WORKER = ['alert', 'attachment', 'badge', 'badge-aslink', 'bubble', 'button', 'button-aschild', 'card', 'empty', 'field', 'input', 'item', 'kbd', 'label', 'marker', 'message', 'skeleton', 'table', 'textarea']

type Server = { base: string; proc: ReturnType<typeof Bun.spawn>; ready?: string }
const servers: Server[] = []
const dists = ['.rows/dist-cn-fold', '.rows/dist-cn-fold-ref', '.rows/dist-cn-fold-static']

function build(out: string, env: Record<string, string>, from = entry) {
  const b = Bun.spawnSync([bin, 'build', from, '--out-dir', out], { cwd: app, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
}

async function start(dist: string, from = entry): Promise<Server> {
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', BRUST_DEV_TOKEN: TOKEN }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', dist, '--entry', from], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  const s = { base: `http://${/listening on (\S+)/.exec(out)![1]}`, proc, ready: /\[brust\] ready \((\d+) worker/.exec(out)?.[1] }
  servers.push(s)
  return s
}

let folded: Server
let reference: Server
let staticOnly: Server
beforeAll(async () => {
  build(dists[0]!, {})
  build(dists[1]!, { BRUST_BUILD_EVAL: '0' })
  build(dists[2]!, {}, staticEntry)
  folded = await start(dists[0]!)
  reference = await start(dists[1]!)
  staticOnly = await start(dists[2]!, staticEntry)
}, 300_000)

afterAll(async () => {
  for (const s of servers) {
    s.proc.kill('SIGINT')
    if ((await Promise.race([s.proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { s.proc.kill('SIGKILL'); await s.proc.exited }
  }
  for (const d of dists) rmSync(join(app, d), { recursive: true, force: true })
})

/** The page and the jobs the core planned for it (its dev trace: `x-brust-dev`, only with the start token). */
async function get(s: Server, page: string): Promise<{ html: string; jobs: number }> {
  const r = await fetch(`${s.base}/${page}`, { headers: { 'x-brust-dev-token': TOKEN } })
  expect(r.status).toBe(200)
  const trace = JSON.parse(Buffer.from(r.headers.get('x-brust-dev') ?? '', 'base64').toString('utf8')) as { jobs: unknown[]; jobs_more: number }
  return { html: await r.text(), jobs: trace.jobs.length + trace.jobs_more }
}

test('R34.93: every page is served byte-identically with the fold on and off', async () => {
  for (const page of PAGES) {
    const [a, b] = [await get(folded, page), await get(reference, page)]
    expect({ page, html: a.html }).toEqual({ page, html: b.html })
    expect(a.jobs, page).toBeLessThan(b.jobs) // every one of these pages lost at least one class job
  }
})

test('R34.95: the 18 class-only pages and field plan no job: Rust answers them without a worker call', async () => {
  const none: string[] = []
  for (const page of PAGES) if ((await get(folded, page)).jobs === 0) none.push(page)
  expect(none).toEqual(NO_WORKER)
})

/** React's server render of a fixture page, from the fixture (its own react, cn and class-variance-authority). */
function react(page: string): string {
  const code = `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import Page from './pages/${page}'; process.stdout.write(renderToStaticMarkup(createElement(Page)))`
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString()
}

/** The page markup of a served document, without brust's own runtime wiring (native hosts, `x-*` attributes). */
function body(html: string, first: string): string {
  const start = html.indexOf(first)
  const close = html.indexOf('</body>')
  const end = close < 0 ? html.length : close
  return html
    .slice(start, end)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<brust-host[^>]*>|<\/brust-host>/g, '')
    .replace(/<!--\/?brust[^>]*-->/g, '')
    .replace(/ x-[a-z-]+="[^"]*"| x-props='[^']*'| x-[a-z-]+(?=[ >])/g, '')
    .trim()
}

test("R34.95: alert, badge, button, card, table and label serve React's markup with the real cn / cva", async () => {
  for (const page of ['alert', 'badge', 'button', 'card', 'table', 'label']) {
    const ours = await get(folded, page)
    // React writes a void element as `<input …/>`, the template as `<input …>`: the same HTML.
    const theirs = react(page).replace(/<(input|img|br|hr)([^>]*)\/>/g, '<$1$2>')
    const first = theirs.slice(0, theirs.indexOf('>') + 1)
    // The same HTML spelled two ways: React writes `'` as `&#x27;` and a boolean attribute as `disabled=""`.
    const same = (h: string) => h.replaceAll('&#x27;', '&#39;').replace(/ ([a-z-]+)=""/g, ' $1')
    expect({ page, html: same(body(ours.html, first.split(' ')[0]!)) }).toEqual({ page, html: same(theirs) })
  }
})

const manifestOf = (dist: string) => JSON.parse(readFileSync(join(app, dist, 'manifest.json'), 'utf8'))
/** `jobs.js`'s table: component id -> the job kinds it carries. */
async function jobsTable(dist: string): Promise<Record<string, string[]>> {
  const mod = await import(join(app, dist, 'jobs.js'))
  return Object.fromEntries(Object.entries(mod.default as Record<string, object>).map(([id, fns]) => [id, Object.keys(fns).sort()]))
}

test('F183: jobs.js carries exactly the jobs a route plans, with the fold on and off', async () => {
  for (const dist of dists.slice(0, 2)) {
    const m = manifestOf(dist)
    const { planned, ssr } = reachedJobs(m)
    const want: Record<string, string[]> = {}
    for (const [id, c] of Object.entries(m.components as Record<string, { jobs: { kind: string }[] }>)) {
      const kinds = [...(planned.has(id) && c.jobs.some((j) => j.kind === 'precompute') ? ['precompute'] : []), ...(ssr.has(id) ? ['ssr'] : [])]
      if (kinds.length > 0) want[id] = kinds
    }
    const have = await jobsTable(dist)
    // a precompute entry exists for every planned component with a precompute job, an ssr entry for every target; nothing else
    for (const [id, kinds] of Object.entries(have)) for (const k of kinds) expect({ dist, id, k, reached: k === 'ssr' ? ssr.has(id) : planned.has(id) }).toEqual({ dist, id, k, reached: true })
    for (const [id, kinds] of Object.entries(want)) expect({ dist, id, kinds: have[id] }).toEqual({ dist, id, kinds })
    // the build compiled jobs no route reaches (each page's folded children): those are gone
    const unreached = Object.entries(m.components as Record<string, { jobs: unknown[] }>).filter(([id, c]) => c.jobs.length > 0 && !planned.has(id))
    if (dist === dists[0]) expect(unreached.length).toBeGreaterThan(0)
  }
})

test('F183: the 19 job-free pages alone need no worker: no job in jobs.js, 0 workers, the same pages', async () => {
  expect(manifestOf(dists[2]!).needs_workers).toBe(false)
  expect(await jobsTable(dists[2]!)).toEqual({})
  expect(staticOnly.ready).toBe('0')
  for (const page of NO_WORKER) {
    const [a, b] = [await get(staticOnly, page), await get(folded, page)]
    expect({ page, html: a.html, jobs: a.jobs }).toEqual({ page, html: b.html, jobs: 0 })
  }
})
