// website/scripts/shots.ts — the visual parity harness of L31 docs-tailwind (R32.6). It screenshots every nav route,
// `/`, `/docs` and the 404, light and dark, 400 px and 1280 px wide, plus light at the two breakpoints' edges
// (560/561 and 980/981 px), full page, then diffs two such runs.
//   bun scripts/shots.ts capture <dir> [--base http://127.0.0.1:1337] [--widths 560,561,980,981]
//                                      # PNGs into <dir>; without --base it builds the site and starts brust (own PID,
//                                      # stopped at the end); --widths shoots only the views of those widths
//   bun scripts/shots.ts compare <baseline> <candidate> [--diff <dir>] [--max <percent>]
// compare prints one row per shot: route, theme, width and the share of differing pixels (pixelmatch, threshold 0.1).
// A shot whose page height changed is compared over the larger size (the missing part counts as different). It exits 1
// when a shot is missing or differs by more than --max percent (default 0).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import pixelmatch from 'pixelmatch'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { PAGES } from '../lib/nav'

const site = join(import.meta.dir, '..')
const bin = join(site, '../packages/brust/bin/brust')

export const THEMES = ['light', 'dark'] as const
export const WIDTHS = [400, 1280] as const
/** Both sides of each breakpoint (max-narrow: below 561 px, max-wide: below 981 px). Every route changes layout there
 * (the header at 560, the footer and the docs grid at 980), so all routes are shot; light only, the layout is the point. */
export const EDGE_WIDTHS = [560, 561, 980, 981] as const
export const THRESHOLD = 0.1
/** A path no route answers: the catch-all renders the 404 page. */
export const NOT_FOUND = '/no-such-page'

/** Every page the harness shoots, in nav order. */
export function routes(): string[] {
  return ['/', '/docs', ...PAGES.map((p) => `/docs/${p.slug}`), NOT_FOUND]
}

/** `/` → `home`, `/docs/cache-adapters/redis` → `docs~cache-adapters~redis`, the 404 → `404`. */
export function shotName(route: string, theme: string, width: number): string {
  const r = route === '/' ? 'home' : route === NOT_FOUND ? '404' : route.slice(1).replaceAll('/', '~')
  return `${r}.${theme}.${width}.png`
}

/** Stops transitions and the caret blink, so two runs of an unchanged page match; animations are off through
 * `reducedMotion: 'reduce'` (the site keeps them behind prefers-reduced-motion: no-preference). */
const FREEZE = '*, *::before, *::after { transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }'

interface Server {
  base: string
  stop: () => Promise<void>
}

/** `brust build` into a scratch dir next to the site, then `brust start` on an ephemeral port. */
async function startSite(): Promise<Server> {
  const out = join(site, `dist-shots-${process.pid}`)
  rmSync(out, { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: site, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`site build failed:\n${b.stdout.toString()}${b.stderr.toString()}`)
  const proc = Bun.spawn([bin, 'start', '--dist-dir', out, '--port', '0', '--workers', '2'], {
    cwd: site,
    env: { ...process.env, BRUST_ADDR: '127.0.0.1', BRUST_PORT: '', BRUST_DIST_DIR: out, BRUST_DRAIN_TIMEOUT_MS: '1000' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const cleanup = async () => {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(10_000).then(() => 'late')])) === 'late') proc.kill('SIGKILL')
    await proc.exited
    rmSync(out, { recursive: true, force: true })
  }
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let log = ''
    const deadline = Date.now() + 120_000
    while (!/\[brust\] ready/.test(log)) {
      if (Date.now() > deadline) throw new Error(`brust start not ready in time:\n${log}`)
      const { done, value } = await reader.read()
      if (done) throw new Error(`brust start exited before ready:\n${log}`)
      log += dec.decode(value, { stream: true })
    }
    void (async () => {
      for (;;) if ((await reader.read()).done) return
    })()
    void new Response(proc.stderr as ReadableStream).text()
    return { base: `http://${/listening on (\S+)/.exec(log)![1]}`, stop: cleanup }
  } catch (e) {
    await cleanup()
    throw e
  }
}

/** Every viewport shot: each theme at each of WIDTHS, then light at each of EDGE_WIDTHS. */
export function views(): { theme: (typeof THEMES)[number]; width: number }[] {
  return [...THEMES.flatMap((theme) => WIDTHS.map((width) => ({ theme, width }))), ...EDGE_WIDTHS.map((width) => ({ theme: 'light' as const, width }))]
}

/** Shoots every route × view into `dir` (created; existing PNGs are overwritten), or only the views whose width is in
 * `only`. Returns the file names. */
export async function capture(dir: string, base?: string, only?: number[]): Promise<string[]> {
  mkdirSync(dir, { recursive: true })
  const srv = base ? { base, stop: async () => {} } : await startSite()
  const browser = await chromium.launch()
  const written: string[] = []
  try {
    for (const { theme, width } of views().filter((v) => !only || only.includes(v.width))) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 1 })
      const page = await ctx.newPage()
      for (const route of routes()) {
        await page.goto(`${srv.base}${route}`, { waitUntil: 'networkidle' })
        await page.addStyleTag({ content: FREEZE })
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        const name = shotName(route, theme, width)
        await page.screenshot({ path: join(dir, name), fullPage: true, animations: 'disabled' })
        written.push(name)
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
    await srv.stop()
  }
  return written
}

export interface Row {
  name: string
  route: string
  theme: string
  width: number
  /** Share of differing pixels, 0-100; null when the candidate has no such shot. */
  percent: number | null
  size: string
}

/** Pads a PNG onto a transparent canvas of `w`×`h`, so two page heights can be compared. */
function padded(png: PNG, w: number, h: number): Uint8Array {
  if (png.width === w && png.height === h) return png.data
  const out = new PNG({ width: w, height: h })
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0)
  return out.data
}

/** Diffs every PNG of `a` against the same name in `b`; writes diff images to `diffDir` when given. */
export function compare(a: string, b: string, diffDir?: string): Row[] {
  if (diffDir) mkdirSync(diffDir, { recursive: true })
  const rows: Row[] = []
  for (const name of readdirSync(a).filter((f) => f.endsWith('.png')).sort()) {
    const [r, theme, width] = name.replace(/\.png$/, '').split('.') as [string, string, string]
    const route = r === 'home' ? '/' : r === '404' ? NOT_FOUND : `/${r.replaceAll('~', '/')}`
    const row = { name, route, theme, width: Number(width) }
    if (!existsSync(join(b, name))) {
      rows.push({ ...row, percent: null, size: 'missing' })
      continue
    }
    const x = PNG.sync.read(readFileSync(join(a, name)))
    const y = PNG.sync.read(readFileSync(join(b, name)))
    const w = Math.max(x.width, y.width)
    const h = Math.max(x.height, y.height)
    const diff = diffDir ? new PNG({ width: w, height: h }) : null
    const n = pixelmatch(padded(x, w, h), padded(y, w, h), diff?.data, w, h, { threshold: THRESHOLD })
    if (diff && n > 0) writeFileSync(join(diffDir!, name), PNG.sync.write(diff))
    const size = x.width === y.width && x.height === y.height ? `${w}x${h}` : `${x.width}x${x.height} -> ${y.width}x${y.height}`
    rows.push({ ...row, percent: (100 * n) / (w * h), size })
  }
  return rows
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2)
  const flag = (f: string) => {
    const i = args.indexOf(f)
    if (i < 0) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  if (cmd === 'capture') {
    const base = flag('--base')
    const widths = flag('--widths')?.split(',').map(Number)
    if (args.length !== 1) throw new Error('usage: bun scripts/shots.ts capture <dir> [--base <url>] [--widths <px,px,...>]')
    const dir = resolve(args[0]!)
    const names = await capture(dir, base, widths)
    console.log(`[shots] ${names.length} shots (${routes().length} routes x ${names.length / routes().length} views) in ${dir}`)
  } else if (cmd === 'compare') {
    const diffDir = flag('--diff')
    const max = Number(flag('--max') ?? '0')
    if (args.length !== 2) throw new Error('usage: bun scripts/shots.ts compare <baseline> <candidate> [--diff <dir>] [--max <percent>]')
    const rows = compare(resolve(args[0]!), resolve(args[1]!), diffDir && resolve(diffDir))
    const over = rows.filter((r) => r.percent === null || r.percent > max)
    for (const r of [...rows].sort((p, q) => (q.percent ?? 101) - (p.percent ?? 101))) {
      const pct = r.percent === null ? 'missing' : `${r.percent.toFixed(3)}%`
      console.log(`${r.route.padEnd(36)} ${r.theme.padEnd(5)} ${String(r.width).padStart(4)}  ${pct.padStart(9)}  ${r.size}`)
    }
    console.log(`[shots] ${rows.length} shots compared, ${over.length} over ${max}%`)
    process.exit(over.length > 0 ? 1 : 0)
  } else {
    throw new Error('usage: bun scripts/shots.ts capture <dir> [--base <url>] [--widths <px,px,...>] | compare <baseline> <candidate> [--diff <dir>] [--max <percent>]')
  }
}
