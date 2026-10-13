// website/scripts/export-static.ts — `bun run export`: the docs site as static files for Cloudflare Pages (plan R1-R3).
// brust v2 has no static export (gap G12), so this builds the site, starts `brust start` on a free port, fetches every
// route, and writes the responses to out/ with Pages' pretty-URL layout:
//   /              -> out/index.html
//   /docs          -> out/docs.html
//   /docs/x/y      -> out/docs/x/y.html
//   the * route    -> out/404.html (Pages answers unknown paths with it, status 404)
// Assets keep their URL paths (/_brust/**, /public/**); they are collected from what the pages and their scripts and
// stylesheets reference, following chunk imports, never from a directory listing. The server is stopped by its own PID.
//
//   bun scripts/export-static.ts [--dist dist-export] [--out out]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PAGES } from '../lib/nav'
import { POKEMON } from '../lib/pokemon'

const app = join(import.meta.dir, '..')
const bin = join(app, 'node_modules/.bin/brust')

/** Every route of the site (plan R3): derived from lib/nav.ts and lib/pokemon.ts, never kept by hand. */
export function exportRoutes(): string[] {
  return ['/', '/docs', ...PAGES.map((p) => `/docs/${p.slug}`), ...POKEMON.map((p) => `/demo/pokemon/${p.name}`)]
}

/** The file a route is written to, relative to the output dir (plan R2). */
export function fileFor(route: string): string {
  return route === '/' ? 'index.html' : `${route.slice(1)}.html`
}

const ASSET = /^\/(_brust|public)\//
/** Root-relative src/href values in a page. */
const refsInHtml = (html: string): string[] => [...html.matchAll(/\b(?:src|href)="(\/[^"#?]*)/g)].map((m) => m[1]!)
/** Static and dynamic import specifiers in a module, and url()/@import targets in a stylesheet. */
const refsInAsset = (path: string, text: string): string[] =>
  path.endsWith('.css')
    ? [...text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/g)].map((m) => (m[1] ?? m[2])!)
    : [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!)

export interface ExportResult {
  pages: string[]
  assets: string[]
  /** Internal links that point at no exported file: on Pages they answer the 404 page. */
  dangling: string[]
}

async function start(dist: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const proc = Bun.spawn([bin, 'start', '--dist-dir', dist, '--port', '0'], {
    cwd: app,
    env: { ...process.env, BRUST_ADDR: '127.0.0.1', BRUST_DIST_DIR: dist, BRUST_DRAIN_TIMEOUT_MS: '1000', BRUST_PORT: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stop = async () => {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(10_000).then(() => 'late')])) === 'late') proc.kill('SIGKILL')
    await proc.exited
  }
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  const deadline = Date.now() + 120_000
  while (!/\[brust\] ready/.test(log)) {
    const { done, value } = await reader.read()
    if (done || Date.now() > deadline) {
      await stop()
      throw new Error(`brust start did not get ready:\n${log}${await new Response(proc.stderr as ReadableStream).text()}`)
    }
    log += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  void new Response(proc.stderr as ReadableStream).text()
  return { base: `http://${/listening on (\S+)/.exec(log)![1]}`, stop }
}

export async function exportStatic({ dist, out }: { dist: string; out: string }): Promise<ExportResult> {
  rmSync(dist, { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', dist], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed (${b.exitCode}):\n${b.stderr.toString()}`)
  rmSync(out, { recursive: true, force: true })
  const write = (file: string, body: Uint8Array | string) => {
    mkdirSync(dirname(join(out, file)), { recursive: true })
    writeFileSync(join(out, file), body)
  }

  const srv = await start(dist)
  try {
    const routes = exportRoutes()
    const queue: string[] = []
    const links = new Set<string>()
    const take = async (path: string, want: number, file: string) => {
      const r = await fetch(srv.base + path, { redirect: 'manual' })
      if (r.status !== want) throw new Error(`GET ${path}: status ${r.status}, want ${want}`)
      const html = await r.text()
      if (html.includes(srv.base)) throw new Error(`GET ${path}: the page names the export server's origin`)
      write(file, html)
      for (const ref of refsInHtml(html)) {
        if (ASSET.test(ref)) queue.push(ref)
        else links.add(ref)
      }
    }
    for (const route of routes) await take(route, 200, fileFor(route))
    // the * route: any path no route matches renders NotFoundPage with status 404
    await take('/__brust-export-not-found__', 404, '404.html')

    const assets = new Set<string>()
    while (queue.length > 0) {
      const path = queue.shift()!
      if (assets.has(path)) continue
      assets.add(path)
      const r = await fetch(srv.base + path)
      if (r.status !== 200) throw new Error(`GET ${path}: status ${r.status} (referenced by an exported file)`)
      const body = new Uint8Array(await r.arrayBuffer())
      write(path.slice(1), body)
      if (/\.(js|css)$/.test(path))
        for (const ref of refsInAsset(path, new TextDecoder().decode(body))) {
          if (/^(data:|https?:|\/\/)/.test(ref)) continue
          const abs = new URL(ref, `http://x${path}`).pathname
          if (!ASSET.test(abs)) throw new Error(`${path} references ${ref}, outside /_brust and /public`)
          queue.push(abs)
        }
    }
    const exported = new Set(routes)
    const dangling = [...links].filter((l) => !exported.has(l.length > 1 ? l.replace(/\/$/, '') : l)).sort()
    return { pages: [...routes, '*'], assets: [...assets].sort(), dangling }
  } finally {
    await srv.stop()
  }
}

if (import.meta.main) {
  const arg = (name: string, fallback: string) => {
    const i = Bun.argv.indexOf(`--${name}`)
    return join(app, i > 0 ? Bun.argv[i + 1]! : fallback)
  }
  const r = await exportStatic({ dist: arg('dist', 'dist-export'), out: arg('out', 'out') })
  console.log(`exported ${r.pages.length} pages and ${r.assets.length} assets to ${arg('out', 'out')}`)
  if (r.dangling.length > 0) console.log(`links to the 404 page: ${r.dangling.join(' ')}`)
}
