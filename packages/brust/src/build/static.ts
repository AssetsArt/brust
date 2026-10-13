// `brust build --target static` (gaps round L9, R9.1-R9.5): after the normal dist is built, render
// every planned page through the real server (a child process, `ssg-render.ts`) and write
// `<out>/static/`: one HTML file per page, `404.html`, the assets the native host serves
// (`layoutAssets`), `_headers`, `_redirects` and an `ssg.json` report. The layout is what
// Cloudflare Pages and Workers Static Assets (`not_found_handling = "404-page"`) serve as is.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FlatRoute } from '../routes'
import { layoutAssets } from './cf-assets'
import { BuildError } from './errors'
import type { Rendered } from './ssg-render'
import { assertNoCacheBindings } from './static-worker'
import { NOT_FOUND_PATH, type PlannedPage, type StaticPlan, paramRoutes, planStatic, ssgOf } from './ssg'

export interface StaticOptions {
  /** `--strict`: a loader reading the request fails the build instead of warning. */
  strict: boolean
}

/** The request reads of one cache key expression (the server's grammar, through the addon). */
export type ExprReads = (expr: string) => string[]

/** R9.3/R9.4: everything that refuses a static build, checked before a byte is written; then the
 * resolved plan. `actions`: whether `[actions]` is configured. */
export async function prepareStatic(
  leaves: FlatRoute[],
  actions: boolean,
  reads: ExprReads,
  log: (s: string) => void,
  cache?: Parameters<typeof assertNoCacheBindings>[0],
): Promise<StaticPlan> {
  // L12: `[actions]` makes the output hybrid (static pages + a Pages Worker for the action prefix).
  if (actions) assertNoCacheBindings(cache)
  let cacheInfo = false
  for (const leaf of leaves) {
    const cache = leaf.chain[leaf.chain.length - 1]?.cache
    if (!cache || ssgOf(leaf) === false) continue
    cacheInfo = true
    for (const [field, expr] of [
      ['prefix', cache.prefix],
      ['bypass', typeof cache.bypass === 'string' ? cache.bypass : undefined],
    ] as const) {
      if (expr === undefined) continue
      let r: string[]
      try {
        r = reads(expr)
      } catch (e) {
        throw new BuildError('ssg-varies', `route ${leaf.id} (${leaf.pattern}) cache.${field}: ${(e as Error).message}`)
      }
      if (r.length > 0)
        throw new BuildError(
          'ssg-varies',
          `route ${leaf.id} (${leaf.pattern}) cache.${field} reads ${r.join(', ')}: the page varies per request, and a static file is one page for everyone (set ssg: false on the route, or drop the read)`,
        )
    }
  }
  if (cacheInfo) log('[brust] static: cache.ttl_seconds does not apply to static files (ignored)')
  const params = new Map<string, unknown>()
  for (const leaf of paramRoutes(leaves)) {
    const ssg = ssgOf(leaf)
    if (!ssg || !ssg.params) continue
    try {
      params.set(leaf.id, await ssg.params())
    } catch (e) {
      throw new BuildError('ssg-params', `route ${leaf.id} (${leaf.pattern}) ssg.params() threw: ${(e as Error).message ?? String(e)}`)
    }
  }
  return planStatic(leaves, params)
}

export interface StaticReport {
  pages: { path: string; file: string; routeId: string }[]
  redirects: { from: string; to: string; status: number }[]
  skipped: { routeId: string; pattern: string }[]
  notFound: { file: '404.html'; routeId: string | null }
  warnings: string[]
}

type SsgRecord =
  | { kind: 'read'; routeId: string; path: string; field: string; key: string }
  | { kind: 'headers'; routeId: string; path: string; names: string[] }

const DEFAULT_404 =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>\n'

/** A `_redirects` source as Cloudflare Pages matches it (review N4): the decoded path, with only what
 * the file format or the decoding needs escaped (whitespace and control characters, and `%`, so a
 * literal `%` is not read as an escape). Non-ASCII stays as UTF-8. */
export function redirectSource(path: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    decoded = path
  }
  return decoded.replace(/[\s%\u0000-\u001f\u007f]/gu, (c) => encodeURIComponent(c))
}

const text = (r: Rendered) => Buffer.from(r.body, 'base64').toString('utf8')
const excerpt = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s).replace(/\s+/g, ' ').trim()

/** Spawns the render child against the dist at `dist`; the rendered responses in plan order and
 * the loader records. `cwd` is the app root (its `brust.toml` is the server's config). */
async function render(dist: string, entry: string, cwd: string, paths: string[]): Promise<{ addr: string; rendered: Rendered[]; records: SsgRecord[] }> {
  const stage = join(dist, '.ssg')
  mkdirSync(stage, { recursive: true })
  const plan = join(stage, 'plan.json')
  const out = join(stage, 'rendered.json')
  const logFile = join(stage, 'records.jsonl')
  const progress = join(stage, 'progress.txt')
  writeFileSync(plan, JSON.stringify(paths))
  writeFileSync(logFile, '')
  writeFileSync(progress, '')
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'ssg-render.ts')], {
    cwd,
    env: {
      ...process.env,
      BRUST_DIST_DIR: dist,
      BRUST_APP_ENTRY: entry,
      BRUST_SSG: '1',
      BRUST_SSG_PLAN: plan,
      BRUST_SSG_OUT: out,
      BRUST_SSG_LOG: logFile,
      BRUST_SSG_PROGRESS: progress,
      BRUST_ADDR: '127.0.0.1',
      BRUST_PORT: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Review N3: the whole render is bounded too; past it the child (our own PID) is killed.
  const totalMs = Number(process.env.BRUST_SSG_TIMEOUT_MS) || 600_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((r) => {
    timer = setTimeout(() => r('late'), totalMs)
  })
  const texts = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const first = await Promise.race([proc.exited, late])
  clearTimeout(timer)
  if (first === 'late') {
    proc.kill('SIGKILL')
    await proc.exited
    const last = readFileSync(progress, 'utf8').trim().split('\n').pop() || '(before the first page)'
    throw new BuildError('ssg-timeout', `the render took longer than ${totalMs} ms (BRUST_SSG_TIMEOUT_MS); it was rendering ${last}`)
  }
  const code = first
  const [stdout, stderr] = await texts
  const result = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { addr: string; pages?: Rendered[]; timeout?: { path: string; ms: number } }) : null
  if (result?.timeout)
    throw new BuildError('ssg-timeout', `GET ${result.timeout.path} did not answer within ${result.timeout.ms} ms (BRUST_SSG_PAGE_TIMEOUT_MS)`)
  if (code !== 0 || !result?.pages) throw new BuildError('ssg-render', `the render server failed (exit ${code}):\n${(stderr || stdout).trim()}`)
  const { addr, pages: rendered } = result as { addr: string; pages: Rendered[] }
  const records = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as SsgRecord)
  rmSync(stage, { recursive: true, force: true })
  return { addr, rendered, records }
}

/** Renders `plan` against the built dist at `dist` and writes `<dist>/static/`. Returns the report. */
export async function writeStatic(
  dist: string,
  o: { entry: string; appRoot: string; plan: StaticPlan; version: string; strict: boolean; log: (s: string) => void; /** The dir as the user will find it (the build renders into a temp dist). */ shownDir?: string },
): Promise<StaticReport> {
  const dir = join(dist, 'static')
  rmSync(dir, { recursive: true, force: true })
  const assetsStage = join(dist, '.ssg-assets')
  const assets = layoutAssets(dist, assetsStage, o.version)
  renameSync(join(assetsStage, 'assets'), dir)
  rmSync(assetsStage, { recursive: true, force: true })
  const warnings = [...assets.warnings]
  const warn = (w: string) => {
    warnings.push(w)
    o.log(w)
  }
  for (const w of assets.warnings) o.log(w)

  // R9.4: [cache] does not apply to static files, so the render must not need its adapter (a Redis
  // that is not running at build time): the render reads a manifest without `cache`, and the dist
  // keeps the real one for `brust start`.
  const manifestFile = join(dist, 'manifest.json')
  const manifest = readFileSync(manifestFile, 'utf8')
  const parsed = JSON.parse(manifest) as { cache?: unknown }
  if (parsed.cache) {
    o.log('[brust] static: [cache] does not apply to static files (ignored while rendering)')
    writeFileSync(manifestFile, `${JSON.stringify({ ...parsed, cache: null }, null, 2)}\n`)
  }
  let r: Awaited<ReturnType<typeof render>>
  try {
    r = await render(dist, o.entry, o.appRoot, o.plan.pages.map((p) => p.path))
  } finally {
    writeFileSync(manifestFile, manifest)
  }
  const { addr, rendered, records } = r
  const report: StaticReport = { pages: [], redirects: [], skipped: o.plan.skipped, notFound: { file: '404.html', routeId: null }, warnings }
  const write = (file: string, body: Buffer) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), body)
  }
  rendered.forEach((r, i) => {
    const page: PlannedPage = o.plan.pages[i]!
    const where = `GET ${page.path} (route ${page.routeId} ${page.pattern})`
    const body = Buffer.from(r.body, 'base64')
    if (text(r).includes(addr) || (r.headers.location ?? '').includes(addr))
      throw new BuildError('ssg-render', `${where}: the response names the render server's loopback origin; a static page must not (build absolute URLs from a configured origin)`)
    if (page.expect === 404) {
      if (r.status !== 404) throw new BuildError('ssg-render', `${where}: the * route answered ${r.status}, want 404: ${excerpt(text(r))}`)
      write('404.html', body)
      report.notFound.routeId = page.routeId
      return
    }
    if (r.status === 200) {
      write(page.file, body)
      report.pages.push({ path: page.path, file: page.file, routeId: page.routeId })
      return
    }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      report.redirects.push({ from: page.path, to: r.headers.location, status: r.status })
      return
    }
    throw new BuildError('ssg-render', `${where}: status ${r.status}, want 200 (or a redirect()): ${excerpt(text(r))}`)
  })
  if (o.plan.defaultNotFound) {
    write('404.html', Buffer.from(DEFAULT_404))
    warn("[brust] warning ssg-404 no '*' route: wrote a default 404.html (without one, Cloudflare Pages serves every unknown path as the home page)")
  }
  writeFileSync(join(dir, '_redirects'), report.redirects.map((r) => `${redirectSource(r.from)} ${r.to} ${r.status}\n`).join(''))

  const seen = new Set<string>()
  const reads: string[] = []
  for (const rec of records) {
    const leaf = o.plan.pages.find((p) => p.routeId === rec.routeId)
    const route = `route ${rec.routeId}${leaf ? ` (${leaf.pattern})` : ''}`
    if (rec.kind === 'headers') {
      const key = `h ${rec.routeId} ${rec.names.join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      warn(`[brust] warning ssg-headers ${route}: the loader's response headers (${rec.names.join(', ')}) are dropped: a static file carries none`)
      continue
    }
    const key = `r ${rec.routeId} ${rec.field} ${rec.key}`
    if (seen.has(key)) continue
    seen.add(key)
    const what = rec.key === '*' ? `lists req.${rec.field}` : `reads req.${rec.field}[${JSON.stringify(rec.key)}]`
    reads.push(`${route} ${what} (at ${rec.path}): the static page is what a visitor with no headers, cookies or query sees`)
  }
  if (reads.length > 0 && o.strict) throw new BuildError('ssg-request-read', reads.join('\n'))
  for (const r of reads) warn(`[brust] warning ssg-request-read ${r}`)

  writeFileSync(join(dir, 'ssg.json'), `${JSON.stringify(report, null, 2)}\n`)
  o.log(
    `[brust] static: ${report.pages.length} page(s), ${report.redirects.length} redirect(s), 404.html${report.notFound.routeId ? '' : ' (default)'}${report.skipped.length ? `, ${report.skipped.length} route(s) ssg: false` : ''} -> ${o.shownDir ?? dir}`,
  )
  return report
}

export { NOT_FOUND_PATH }
