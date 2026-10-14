// R34.96 PR 2b (job fusion) on started servers: the five shadcn pages a fused child moved off React, built twice (class
// jobs evaluated at build, and BRUST_BUILD_EVAL=0, every fused job run per request). Both builds serve each page
// byte-identically, no page is React or ships an island, and each serves React's own markup with the real cn /
// class-variance-authority / radix-ui. Run alone: `bun test --timeout 300000 tests/server/fused-jobs.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../fixtures/shadcn')
const entry = 'fused/routes.tsx'
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const PAGES = ['button-group', 'field', 'input-group', 'pagination', 'separator']

type Server = { base: string; proc: ReturnType<typeof Bun.spawn> }
const servers: Server[] = []
const dists = ['.rows/dist-fused', '.rows/dist-fused-ref']

function build(out: string, env: Record<string, string>) {
  const b = Bun.spawnSync([bin, 'build', entry, '--out-dir', out], { cwd: app, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
}

async function start(dist: string): Promise<Server> {
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', dist, '--entry', entry], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  const s = { base: `http://${/listening on (\S+)/.exec(out)![1]}`, proc }
  servers.push(s)
  return s
}

let folded: Server
let perRequest: Server
beforeAll(async () => {
  build(dists[0]!, {})
  build(dists[1]!, { BRUST_BUILD_EVAL: '0' })
  folded = await start(dists[0]!)
  perRequest = await start(dists[1]!)
}, 300_000)

afterAll(async () => {
  for (const s of servers) {
    s.proc.kill('SIGINT')
    if ((await Promise.race([s.proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { s.proc.kill('SIGKILL'); await s.proc.exited }
  }
  for (const d of dists) rmSync(join(app, d), { recursive: true, force: true })
})

async function get(s: Server, page: string): Promise<string> {
  const r = await fetch(`${s.base}/${page}`)
  expect({ page, status: r.status }).toEqual({ page, status: 200 })
  return r.text()
}

test('no component of these pages is React (each was an island before fusion)', () => {
  for (const dist of dists) {
    const m = JSON.parse(readFileSync(join(app, dist, 'manifest.json'), 'utf8'))
    // The children-label pin (below) may fall back: only the five shadcn pages' components count.
    const comps = Object.entries(m.components).filter(([id]) => !id.startsWith('childrenLabel')) as [string, { tier: string }][]
    expect({ dist, react: comps.filter(([, c]) => c.tier === 'react').map(([id]) => id) }).toEqual({ dist, react: [] })
  }
})

test('every page is served byte-identically with the fused jobs evaluated at build and run per request', async () => {
  for (const page of PAGES) expect({ page, html: await get(folded, page) }).toEqual({ page, html: await get(perRequest, page) })
})

/** React's server render of a fixture page, from the fixture (its own react, cn, class-variance-authority, radix-ui). */
function react(page: string, from = `./pages/${page}`): string {
  const code = `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import Page from '${from}'; process.stdout.write(renderToStaticMarkup(createElement(Page)))`
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

test("every page serves React's markup, folded and per request", async () => {
  const bad: { page: string; how: string; ours: string; theirs: string }[] = []
  for (const page of PAGES) {
    // React writes a void element as `<input …/>`, the template as `<input …>`: the same HTML.
    const theirs = react(page).replace(/<(input|img|br|hr)([^>]*)\/>/g, '<$1$2>')
    const first = theirs.slice(0, theirs.indexOf('>') + 1).split(' ')[0]!.replace(/>$/, '')
    // The same HTML spelled two ways: React writes `'` as `&#x27;` and a boolean attribute as `disabled=""`.
    const same = (h: string) => h.replace(/>\s+</g, "><").replaceAll('&#x27;', '&#39;').replace(/ ([a-z-]+)=""/g, ' $1')
    for (const [how, s] of [['folded', folded], ['per request', perRequest]] as const) {
      const ours = same(body(await get(s, page), first))
      if (ours !== same(theirs)) bad.push({ page, how, ours, theirs: same(theirs) })
    }
  }
  if (process.env.FUSED_DUMP) Bun.write(process.env.FUSED_DUMP, JSON.stringify(bad))
  expect(bad.map((b) => `${b.page} (${b.how})`)).toEqual([])
})

test("review r1 pin: a child fed the parent's own children is not fused and serves React's markup", async () => {
  const theirs = react('children-label', './fused/children-label')
  expect(theirs).toContain('class="cell on"')
  // The parent falls back to a React island: compare the markup inside its host element.
  const same = (h: string) => h.replace(/>\s+</g, '><').replace(/<brust-island[^>]*>|<\/brust-island>/g, '')
  for (const s of [folded, perRequest]) expect(same(body(await get(s, 'children-label'), '<table'))).toBe(same(theirs))
})
