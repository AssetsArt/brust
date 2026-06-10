// SSG route selection + static export. `collectStaticPaths` decides which
// flattened routes can be prerendered to static HTML and where each one lands
// on disk (pure, no fs access); `exportStatic` boots the just-built dist once,
// crawls the included routes, and writes the static site + assets.

import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

/** Structural subset of routes.ts FlatRoute that SSG selection needs. The
 * `routes` array the app's routes module exports satisfies this (build.ts
 * already imports it for CSS/native emit — no introspection endpoint). */
export interface FlatRouteLike {
  /** Full path Rust matches against (e.g. '/', '/docs/intro', '/pokemon/{name}'). */
  fullPath: string
  /** Chain of Route nodes from root to leaf, inclusive. Only the LEAF node
   * can carry sse/websocket (defineRoutes forbids children on those). */
  chain: { sse?: unknown; websocket?: unknown }[]
}

export interface SsgRouteDecision {
  /** Normalized fullPath (trailing slash stripped; '/' stays '/'). */
  fullPath: string
  include: boolean
  reason?: 'dynamic-param' | 'wildcard' | 'sse' | 'websocket'
  outFile: string // 'index.html' | 'docs/intro/index.html' …
}

/** Strip trailing slashes ('/docs/intro/' → '/docs/intro'); root stays '/'. */
function normalizePath(p: string): string {
  let s = p.startsWith('/') ? p : `/${p}`
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** '/' → 'index.html'; '/docs/intro' → 'docs/intro/index.html'. Input must be
 * normalized (no trailing slash). */
function outFileFor(normalized: string): string {
  if (normalized === '/') return 'index.html'
  return `${normalized.slice(1)}/index.html`
}

/** Decide, for every flattened route, whether it can be statically prerendered
 * and which file it maps to. Deterministic: trailing-slash duplicates collapse
 * to one decision (first occurrence wins) and output is sorted by fullPath. */
export function collectStaticPaths(flatRoutes: FlatRouteLike[]): SsgRouteDecision[] {
  const seen = new Set<string>()
  const decisions: SsgRouteDecision[] = []

  for (const route of flatRoutes) {
    const fullPath = normalizePath(route.fullPath)
    if (seen.has(fullPath)) continue
    seen.add(fullPath)

    const leaf = route.chain[route.chain.length - 1]
    let reason: SsgRouteDecision['reason']
    if (/\{[^/]*\}/.test(fullPath)) {
      reason = 'dynamic-param'
    } else if (fullPath.includes('*')) {
      reason = 'wildcard'
    } else if (leaf?.sse != null) {
      reason = 'sse'
    } else if (leaf?.websocket != null) {
      reason = 'websocket'
    }

    const decision: SsgRouteDecision = {
      fullPath,
      include: reason === undefined,
      outFile: outFileFor(fullPath),
    }
    if (reason !== undefined) decision.reason = reason
    decisions.push(decision)
  }

  decisions.sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0))
  return decisions
}

// ----- static export -----

const READY_LINE = '[brust] listening on' // println! in brust-core server/mod.rs
const READY_TIMEOUT_MS = 30_000
const CRAWL_CONCURRENCY = 4
/** Grace period after SIGINT before escalating to SIGKILL — an orphaned server
 * breaks later port-sensitive tests/builds. */
const KILL_GRACE_MS = 5_000

/** Bind-then-release an ephemeral port (same pattern as the integration suite —
 * deliberately copied, tests/ must not be imported from runtime/). */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as import('node:net').AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

/** Read the child's stdout until the brust listening line appears (30s cap).
 * Captures stdout AND stderr into `capture` so a boot failure surfaces the
 * child's own output. After readiness both pipes keep draining in the
 * background — a full pipe would block the child mid-crawl. */
async function waitForListening(
  proc: ReturnType<typeof Bun.spawn>,
  capture: { stdout: string; stderr: string },
): Promise<void> {
  const dec = new TextDecoder()

  const stderr = proc.stderr as ReadableStream<Uint8Array> | undefined
  if (stderr) {
    void (async () => {
      try {
        for await (const chunk of stderr) capture.stderr += dec.decode(chunk, { stream: true })
      } catch {
        /* child killed mid-read */
      }
    })()
  }

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const ready = (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('server exited before printing the listening line')
      capture.stdout += dec.decode(value, { stream: true })
      if (capture.stdout.includes(READY_LINE)) return
    }
  })()
  ready.catch(() => {}) // if the timeout wins the race, don't leave an unhandled rejection

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`server not ready within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS,
    )
  })

  try {
    await Promise.race([ready, timeout])
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\n--- child stdout ---\n${capture.stdout}\n--- child stderr ---\n${capture.stderr}`,
    )
  } finally {
    clearTimeout(timer)
  }

  void (async () => {
    try {
      while (!(await reader.read()).done) {
        /* discard — drain only */
      }
    } catch {
      /* child killed mid-read */
    }
  })()
}

/** Boot the just-built dist on a free port, crawl every included route, and
 * write the static site to `staticOut` (clobbered first). ANY non-200 fails
 * the whole export — the partial output is removed and the error rethrown.
 * Asset copy preserves the live server's URL shape: islands + css under
 * /_brust/, public/ root-mapped (runtime/index.ts configurePublicDir). */
export async function exportStatic(opts: {
  distDir: string // the just-built outDir
  entryDir: string // app dir (for public/)
  staticOut: string // e.g. dist/static (clobbered first)
  routes: SsgRouteDecision[]
}): Promise<{ written: string[]; skipped: SsgRouteDecision[] }> {
  const { distDir, entryDir, staticOut, routes } = opts
  const included = routes.filter((r) => r.include)
  const skipped = routes.filter((r) => !r.include)

  await rm(staticOut, { recursive: true, force: true })
  await mkdir(staticOut, { recursive: true })

  const written: string[] = []
  if (included.length > 0) {
    const port = await freePort()
    const proc = Bun.spawn(['bun', join(distDir, 'index.js')], {
      env: { ...process.env, BRUST_PORT: String(port), BRUST_WORKERS: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      await waitForListening(proc, { stdout: '', stderr: '' })

      let next = 0
      const crawlOne = async (d: SsgRouteDecision) => {
        const resp = await fetch(`http://127.0.0.1:${port}${d.fullPath}`)
        const body = await resp.text()
        if (resp.status !== 200) {
          throw new Error(`GET ${d.fullPath} → ${resp.status}\n${body.slice(0, 500)}`)
        }
        const outPath = join(staticOut, d.outFile)
        await mkdir(dirname(outPath), { recursive: true })
        await Bun.write(outPath, body)
        written.push(d.outFile)
      }
      const workers = Array.from(
        { length: Math.min(CRAWL_CONCURRENCY, included.length) },
        async () => {
          while (true) {
            const i = next++
            if (i >= included.length) return
            await crawlOne(included[i])
          }
        },
      )
      // Let every worker settle BEFORE failing — an in-flight write racing the
      // cleanup rm below would resurrect a partial staticOut.
      const settled = await Promise.allSettled(workers)
      const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
      if (failed) throw failed.reason
    } catch (err) {
      // No partial site: a failed crawl removes everything it wrote.
      await rm(staticOut, { recursive: true, force: true }).catch(() => {})
      throw err
    } finally {
      // ALWAYS kill the child — an orphaned server breaks later port users.
      // Bounded even past SIGKILL: a build tool must never hang on a child that
      // a shell wrapper kept alive; CI timeouts are not a cleanup strategy.
      proc.kill('SIGINT')
      const hardKill = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS)
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), KILL_GRACE_MS + 3_000)),
      ])
      clearTimeout(hardKill)
      if (!exited) {
        console.warn('[brust build] ssg: dist server did not exit after SIGKILL — abandoning it')
      }
    }
  }

  const islandsSrc = join(distDir, 'islands')
  if (existsSync(islandsSrc)) {
    await cp(islandsSrc, join(staticOut, '_brust', 'islands'), { recursive: true })
  }
  const cssSrc = join(distDir, 'css')
  if (existsSync(cssSrc)) {
    await cp(cssSrc, join(staticOut, '_brust', 'css'), { recursive: true })
  }
  const publicSrc = join(entryDir, 'public')
  if (existsSync(publicSrc)) {
    await cp(publicSrc, staticOut, { recursive: true })
  }

  written.sort()
  return { written, skipped }
}
