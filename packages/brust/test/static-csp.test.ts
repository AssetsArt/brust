// F541: `[csp]` in a `brust build --target static` output (test/fixtures/csp-static-app, under /site). Every page, the
// default 404 included, carries `<meta http-equiv="Content-Security-Policy">` as the first element of its <head>, whose
// content is the core's split (`cspForStatic`) of the header `brust start` sends on the same dist, and whose script-src
// lists the sha256 of every inline script the page holds. Directives a meta cannot hold go to the one `/*` rule of
// `_headers`; report-only is that rule alone; no [csp] = neither. The pure helpers are tested without a build.
// The Chromium half lives in tests/server/csp-static.chromium.test.ts.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withCspHeader } from '../src/build/cf-assets'
import { pageCsp, withCspMeta } from '../src/build/static'
import type { Rendered } from '../src/build/ssg-render'
import { cspForStatic } from '../src/native'

const fixture = join(import.meta.dir, 'fixtures/csp-static-app')
const bin = join(import.meta.dir, '../bin/brust')
const env = { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', BRUST_WORKERS: '', NODE_ENV: 'production' }
const copies: string[] = []

/** A copy of the fixture inside the package (so `@brust/core` resolves) with `csp` as its [csp] table, built static. */
function built(name: string, csp: string): string {
  const dir = join(import.meta.dir, `fixtures/.csp-static-${name}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(fixture, dir, { recursive: true, filter: (src) => !/[\\/](dist|\.brust)/.test(src) })
  copies.push(dir)
  writeFileSync(join(dir, 'brust.toml'), `[server]\nbase_path = "/site"\n\n${csp}`)
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx', '--target', 'static'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build --target static (${name}) failed:\n${b.stderr.toString()}`)
  return dir
}

/** The policy header `brust start` sends for `path` on the dist of `dir`: [name, value]. */
async function served(dir: string, path: string): Promise<[string, string]> {
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: dir, env, stdout: 'pipe', stderr: 'inherit' })
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    let log = ''
    while (!/\[brust\] ready/.test(log) || !/listening on (\S+)/.test(log)) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`brust start exited before ready:\n${log}`)
      log += new TextDecoder().decode(value)
    }
    const r = await fetch(`http://${/listening on (\S+)/.exec(log)![1]}${path}`)
    for (const n of ['content-security-policy', 'content-security-policy-report-only']) {
      const v = r.headers.get(n)
      if (v !== null) return [n, v]
    }
    throw new Error(`no policy header on ${path}`)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}

const htmlFiles = (dir: string) =>
  readdirSync(join(dir, 'dist/static'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.html'))
    .sort()
const read = (dir: string, f: string) => readFileSync(join(dir, 'dist/static', f), 'utf8')
const metaOf = (html: string) => /<head[^>]*><meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1]?.replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`

let enforce = ''
let reportOnly = ''
let off = ''
beforeAll(() => {
  enforce = built('enforce', '[csp]\nenabled = true\nframe_ancestors = ["\'none\'"]\nreport_uri = "/csp-report"\n')
  reportOnly = built('report-only', '[csp]\nenabled = true\nmode = "report-only"\n')
  off = built('off', '')
}, 300_000)

afterAll(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true })
})

test('enforce: every page (default 404 too) has the meta first in <head>, == the core split of the served header', async () => {
  const files = htmlFiles(enforce)
  expect(files).toEqual(['404.html', 'site.html', 'site/about.html'])
  const [name, value] = await served(enforce, '/site')
  const want = cspForStatic(name, value)
  expect(want.meta).toBeString()
  for (const f of files) {
    const html = read(enforce, f)
    expect([f, metaOf(html)]).toEqual([f, want.meta!])
    expect(html.match(/http-equiv="Content-Security-Policy"/g)?.length).toBe(1)
  }
  // a meta cannot hold these: they are not in it, and they go to the host's one /* rule
  expect(want.meta).not.toContain('frame-ancestors')
  expect(want.meta).not.toContain('report-uri')
  expect(want.headerName).toBe('Content-Security-Policy')
  expect(want.headerValue).toBe("frame-ancestors 'none'; report-uri /csp-report")
  const headers = read(enforce, '_headers')
  expect(headers.startsWith(`/*\n  Content-Security-Policy: frame-ancestors 'none'; report-uri /csp-report\n  X-Content-Type-Options: nosniff\n`)).toBe(true)
  expect(headers.match(/Content-Security-Policy/g)?.length).toBe(1)
}, 120_000)

test("enforce: script-src lists the sha256 of every inline script a page holds", () => {
  for (const f of htmlFiles(enforce)) {
    const html = read(enforce, f)
    const meta = metaOf(html)!
    const src = meta.split('; ').find((d) => d.startsWith('script-src '))!.split(' ')
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    for (const text of inline) expect([f, src.includes(sha(text))]).toEqual([f, true])
    if (f === 'site.html') expect(inline.length).toBeGreaterThan(0)
  }
})

test('report-only: no meta (it cannot be one), the whole policy in the /* rule as Content-Security-Policy-Report-Only', async () => {
  for (const f of htmlFiles(reportOnly)) expect([f, read(reportOnly, f).includes('http-equiv="Content-Security-Policy"')]).toEqual([f, false])
  const [name, value] = await served(reportOnly, '/site')
  expect(name).toBe('content-security-policy-report-only')
  expect(read(reportOnly, '_headers').startsWith(`/*\n  Content-Security-Policy-Report-Only: ${value}\n`)).toBe(true)
}, 120_000)

test('no [csp]: no meta and no policy rule', () => {
  for (const f of htmlFiles(off)) expect([f, read(off, f).includes('Content-Security-Policy')]).toEqual([f, false])
  expect(read(off, '_headers')).not.toContain('Content-Security-Policy')
})

// ---- the pure helpers ----

const page = (headers: Record<string, string>): Rendered => ({ path: '/', status: 200, headers, body: '' })
const split = (name: string, value: string) =>
  name.endsWith('report-only') ? { meta: null, headerName: 'Content-Security-Policy-Report-Only', headerValue: value } : { meta: value.replace(/; frame-ancestors .*/, ''), headerName: value.includes('frame-ancestors') ? 'Content-Security-Policy' : null, headerValue: value.includes('frame-ancestors') ? value.replace(/.*; (frame-ancestors .*)/, '$1') : null }

test('pageCsp: a meta per page from its own header; one rule, the most common; a page-only rule is dropped with a warning', () => {
  const brust = "default-src 'self'; frame-ancestors 'none'"
  const own = "default-src 'none'; frame-ancestors 'self'"
  const c = pageCsp([page({ 'content-security-policy': brust }), page({}), page({ 'content-security-policy': own }), page({ 'content-security-policy': brust })], split)
  expect(c.metas).toEqual(["default-src 'self'", undefined, "default-src 'none'", "default-src 'self'"])
  expect(c.common).toBe("default-src 'self'")
  expect(c.header).toEqual(['Content-Security-Policy', "frame-ancestors 'none'"])
  expect(c.warnings).toEqual([`[brust] warning ssg-csp-header Content-Security-Policy: frame-ancestors 'self' is set by a page of its own; a static host sends one header rule for every page, so it is dropped`])
  const ro = pageCsp([page({ 'content-security-policy-report-only': 'default-src x' })], split)
  expect(ro).toEqual({ metas: [undefined], common: undefined, header: ['Content-Security-Policy-Report-Only', 'default-src x'], warnings: [] })
})

test('withCspMeta: first in <head>, attribute escaped; no <head> is a build error', () => {
  expect(withCspMeta('<!doctype html><html><HEAD lang="x"><meta charset="utf-8"></HEAD></html>', `a 'b' "c" <d> &e`, 'p')).toBe(
    `<!doctype html><html><HEAD lang="x"><meta http-equiv="Content-Security-Policy" content="a 'b' &#34;c&#34; &#60;d&#62; &#38;e"><meta charset="utf-8"></HEAD></html>`,
  )
  // <header> is not <head>
  expect(() => withCspMeta('<html><body><header>x</header></body></html>', 'p', 'GET /x')).toThrow('GET /x: no <head>')
})

test('withCspHeader: into the existing /* rule, or a new one first', () => {
  expect(withCspHeader('/*\n  X-A: 1\n\n/b\n  X-B: 2\n', ['N', 'v'])).toBe('/*\n  N: v\n  X-A: 1\n\n/b\n  X-B: 2\n')
  expect(withCspHeader('/b\n  X-B: 2\n', ['N', 'v'])).toBe('/*\n  N: v\n\n/b\n  X-B: 2\n')
})
