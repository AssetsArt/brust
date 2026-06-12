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
   * can carry sse/websocket (defineRoutes forbids children on those) — and
   * only the leaf's `ssg`/`native` are consulted by expandDynamicRoutes. */
  chain: { sse?: unknown; websocket?: unknown; native?: unknown; ssg?: RouteSsgLike }[]
}

export interface SsgRouteDecision {
  /** Normalized fullPath (trailing slash stripped; '/' stays '/'). */
  fullPath: string
  include: boolean
  reason?: 'dynamic-param' | 'wildcard' | 'sse' | 'websocket'
  outFile: string // 'index.html' | 'docs/intro/index.html' …
}

/** Decode a single URL path segment for on-disk use. Static hosts decode the
 * request URL before file lookup, so the file must use the decoded form. We
 * decode per-segment (not the whole path) so that a literal '/' or '\' inside
 * a segment (%2F / %5C) cannot create directory traversal — those are
 * re-encoded after decoding. Malformed percent sequences that would cause
 * decodeURIComponent to throw are decoded triplet-by-triplet: each valid
 * triplet is decoded, each invalid one is left as-is. */
function decodeSegment(seg: string): string {
  // Fast path: nothing to decode.
  if (!seg.includes('%')) return seg

  // Try the whole segment first (common case: all triplets valid).
  try {
    const decoded = decodeURIComponent(seg)
    // Re-encode decoded path separators to prevent directory traversal.
    return decoded.replace(/\//g, '%2F').replace(/\\/g, '%5C')
  } catch {
    // Fallback: decode each /%[0-9A-Fa-f]{2}/ triplet individually.
    const result = seg.replace(/%[0-9A-Fa-f]{2}/g, (triplet) => {
      try {
        const decoded = decodeURIComponent(triplet)
        // Re-encode path separators even in the per-triplet pass.
        if (decoded === '/') return '%2F'
        if (decoded === '\\') return '%5C'
        return decoded
      } catch {
        return triplet
      }
    })
    return result
  }
}

/** Produce the decoded on-disk path from a normalised URL path. Each segment
 * is decoded independently so separator characters cannot escape; `.`/`..`
 * segments (raw or decoded — encodeURIComponent leaves dots alone) are
 * percent-encoded so a hostile param value can never traverse out of the
 * static output directory. */
function decodePathForDisk(normalized: string): string {
  return normalized
    .split('/')
    .map((seg) => {
      const decoded = decodeSegment(seg)
      if (decoded === '.') return '%2E'
      if (decoded === '..') return '%2E%2E'
      return decoded
    })
    .join('/')
}

/** Strip trailing slashes ('/docs/intro/' → '/docs/intro'); root stays '/'. */
function normalizePath(p: string): string {
  let s = p.startsWith('/') ? p : `/${p}`
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** '/' → 'index.html'; '/docs/intro' → 'docs/intro/index.html'. Input must be
 * normalized (no trailing slash). On-disk names use the decoded form because
 * static hosts decode the request URL before file lookup. */
function outFileFor(normalized: string): string {
  if (normalized === '/') return 'index.html'
  return `${decodePathForDisk(normalized.slice(1))}/index.html`
}

/** Where a route's SPA navigation payload lands on disk. The client navigator
 * fetches `/_brust/page${pathname}` (bootstrap.ts navigate()), so the payload
 * must be reachable at that exact URL on a dumb static host — which means
 * `<url>/index.html`, the same directory-index shape the pages use:
 * '/' → '_brust/page/index.html'; '/docs/intro' → '_brust/page/docs/intro/index.html'.
 * On-disk names use the decoded form for the same reason as outFileFor. */
export function navPayloadFileFor(normalized: string): string {
  if (normalized === '/') return join('_brust', 'page', 'index.html')
  const decoded = decodePathForDisk(normalized.slice(1))
  return join('_brust', 'page', decoded, 'index.html')
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

// ----- expandDynamicRoutes -----

/** Reserved sentinel param value (Phase B fallback shell crawl). */
export const SSG_FALLBACK_SENTINEL = '__brust_fallback__'

/** Definitely-unmatched URL path used to crawl the GLOBAL catch-all into
 * 404.html: the dist server's NotFound tier renders the global catch-all at
 * status 404 for any path no real route matches. Deliberately bogus — a
 * double-underscore-namespaced segment no app route declares. NOT `/_brust/`-
 * prefixed: those resolve to brust-internal handlers BEFORE route matching, so
 * the catch-all tier would never see them. */
export const SSG_NOT_FOUND_SENTINEL_PATH = '/__brust_not_found_sentinel__'

/** Structural view of the leaf's ssg config (mirrors RouteSsgConfig). */
export interface RouteSsgLike {
  params?: () => Array<Record<string, string>> | Promise<Array<Record<string, string>>>
  fallback?: 'none' | 'client'
}
/** Unique `{name}`s in declaration order. A repeated name (`/x/{id}/y/{id}`)
 * validates once and substitutes ALL occurrences via replaceAll below. The
 * regex is function-local: a module-level /g regex is a stateful-lastIndex
 * trap for any future exec/test caller. */
function paramNames(fullPath: string): string[] {
  return [...new Set([...fullPath.matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]!))]
}

/** Expand `ssg.params()` routes into concrete prerenderable paths. The
 * pattern route stays in its ORIGINAL list position (never re-appended);
 * concrete entries are appended sharing the same chain reference. Throws on
 * any validation error — build must exit 1, never a silent partial export. */
export async function expandDynamicRoutes(flatRoutes: FlatRouteLike[]): Promise<FlatRouteLike[]> {
  const out = [...flatRoutes]
  for (const route of flatRoutes) {
    const leaf = route.chain[route.chain.length - 1]
    const ssg = leaf?.ssg
    if (!ssg) continue
    const names = paramNames(route.fullPath)
    if (names.length === 0) {
      throw new Error(
        `ssg config on "${route.fullPath}": route has no {param} segment — remove the dead config`,
      )
    }
    if (ssg.fallback === 'client' && leaf?.native) {
      throw new Error(
        `ssg.fallback 'client' on "${route.fullPath}": native (jinja) routes cannot client-render — use the island-fetch pattern instead`,
      )
    }
    if (!ssg.params) continue
    let records: Array<Record<string, string>>
    try {
      records = await ssg.params()
    } catch (err) {
      throw new Error(
        `ssg.params for "${route.fullPath}" threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!Array.isArray(records)) {
      throw new Error(`ssg.params for "${route.fullPath}": expected an array of records`)
    }
    const seen = new Set<string>()
    for (const [i, record] of records.entries()) {
      let concrete = route.fullPath
      for (const name of names) {
        const v = record?.[name]
        if (typeof v !== 'string' || v === '') {
          throw new Error(
            `ssg.params for "${route.fullPath}": record #${i + 1} missing non-empty '${name}'`,
          )
        }
        if (v === SSG_FALLBACK_SENTINEL) {
          throw new Error(
            `ssg.params for "${route.fullPath}": record #${i + 1} uses the reserved value ${SSG_FALLBACK_SENTINEL}`,
          )
        }
        // encodeURIComponent leaves dots alone, so '.'/'..' would survive into
        // the crawl path (where fetch normalizes them away — the crawl would
        // silently hit a DIFFERENT route) and into the on-disk path.
        if (v === '.' || v === '..') {
          throw new Error(
            `ssg.params for "${route.fullPath}": record #${i + 1} value '${v}' for '${name}' is not a valid path segment`,
          )
        }
        concrete = concrete.replaceAll(`{${name}}`, encodeURIComponent(v))
      }
      if (seen.has(concrete)) continue
      seen.add(concrete)
      out.push({ fullPath: concrete, chain: route.chain })
    }
  }
  return out
}

// ----- fallback chunk helpers (Phase B) -----

/** On-disk directory for a pattern's fallback artifacts: `{param}` → `__param__`
 * (curly braces are hostile to static hosts / shells), leading slash stripped.
 * '/blog/{slug}' → 'blog/__slug__'. Pure string fn. */
export function fallbackDiskPath(pattern: string): string {
  return pattern.replace(/^\//, '').replace(/\{([^/}]+)\}/g, '__$1__')
}

/** The URL the build crawler requests for a fallback shell: every `{param}`
 * replaced by the reserved sentinel. '/d/{a}' → '/d/__brust_fallback__'. */
export function fallbackSentinelPath(pattern: string): string {
  return pattern.replace(/\{[^/}]+\}/g, SSG_FALLBACK_SENTINEL)
}

/** Generated entry module for a route's fallback chunk: re-exports the leaf
 * component (default export) and its `clientLoader` under the names the client
 * takeover runtime imports. */
export function fallbackEntrySource(componentSourcePath: string): string {
  // JSON.stringify the specifier so quotes/backslashes in the path can never
  // break the generated module syntax.
  const spec = JSON.stringify(componentSourcePath)
  return `import C, { clientLoader } from ${spec}\nexport { C as Component, clientLoader }\n`
}

/** Does the component source `export` a `clientLoader`? Covers const / let /
 * function / async-function declarations AND the `export { clientLoader }` /
 * `export { x as clientLoader }` re-export forms. Line + block comments are
 * stripped first so a commented-out export doesn't count (naive strip — a
 * `//` inside a string literal on the same line as the export is the known
 * residual; failure mode is a clear build error, not a silent miss). */
export function hasClientLoaderExport(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  if (/export\s+(const|let|async\s+function|function)\s+clientLoader\b/.test(code)) return true
  return /export\s*\{[^}]*\bclientLoader\b[^}]*\}/.test(code)
}

/** The redirect-only `<script>` for `fallback: 'client'` routes (no surrounding
 * document): inlines the [{pattern, doc}] manifest pairs; a path matching a
 * fallback pattern stashes the REAL url in sessionStorage (the takeover runtime
 * restores it via history.replaceState) and redirects to the prerendered
 * fallback shell. No match → no-op (the surrounding document is the 404 body).
 * Extracted so it can be wrapped in the minimal `fallback404Html` shell OR
 * injected into a crawled global-404 page (compose404Html). Pure string fn so
 * the script/inline-JSON contract is unit-testable. Escapes for the <script>
 * context: `<`/`>` (no `</script>`/`<!--`/`-->` sequences) and U+2028/U+2029
 * (legal in JSON, illegal in pre-ES2019-parsed JS string literals). Patterns
 * are author-controlled — belt-and-braces, not a trust boundary. */
export function fallback404Script(pairs: Array<{ pattern: string; doc: string }>): string {
  const inlineJson = JSON.stringify(pairs)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<script>
(function () {
  var MANIFEST = ${inlineJson};
  function match(pattern, path) {
    var p = pattern.split('/'), u = path.split('/')
    if (p.length !== u.length) return false
    for (var i = 0; i < p.length; i++) {
      if (p[i].charAt(0) === '{') { if (!u[i]) return false }
      else if (p[i] !== u[i]) return false
    }
    return true
  }
  for (var i = 0; i < MANIFEST.length; i++) {
    if (match(MANIFEST[i].pattern, location.pathname)) {
      try { sessionStorage.setItem('brust:fallback-path', location.pathname + location.search) } catch (e) {}
      location.replace(MANIFEST[i].doc)
      return
    }
  }
})()
</script>`
}

/** Static-host 404 document for `fallback: 'client'` routes when NO global
 * catch-all page exists: the minimal shell (`<p>Not found.</p>`) wrapping the
 * redirect `<script>` from `fallback404Script`. When a global catch-all DOES
 * exist its crawled page is the document and the script is injected instead
 * (compose404Html) — this shell is unused in that case. */
export function fallback404Html(pairs: Array<{ pattern: string; doc: string }>): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>404</title></head><body>
<p>Not found.</p>
${fallback404Script(pairs)}</body></html>
`
}

/** Inject `<script>…</script>` into `html` just before the closing `</body>`
 * (last occurrence, case-insensitive). If the document has no `</body>` the
 * script is appended — a static host still parses a trailing script. Used to
 * compose the fallback redirect into a crawled global-404 page. */
export function injectBeforeBodyClose(html: string, script: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>')
  if (idx === -1) return `${html}\n${script}`
  return `${html.slice(0, idx)}${script}\n${html.slice(idx)}`
}

/** Compose the final SSG `404.html` from a crawled global-catch-all page and,
 * when `fallback: 'client'` routes also exist, the fallback redirect `<script>`
 * injected before `</body>`. With no fallback pairs the crawled page is
 * returned verbatim (pure rendered 404 page). */
export function compose404Html(
  crawled: string,
  fallbackPairs: Array<{ pattern: string; doc: string }>,
): string {
  if (fallbackPairs.length === 0) return crawled
  return injectBeforeBodyClose(crawled, fallback404Script(fallbackPairs))
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
 *
 * Each route is crawled TWICE: the full document (→ outFile) and its SPA
 * navigation payload `/_brust/page<path>` (→ navPayloadFileFor), the same
 * JSON `{html,title,store}` the live server returns. With the payloads on
 * disk at the URLs the client navigator already fetches, internal links on
 * the static site navigate SPA-style instead of full-reloading; any host
 * 404/redirect-to-HTML still lands in the navigator's full-reload fallback.
 *
 * `fallback: 'client'` routes additionally get their sentinel SHELL crawled
 * (header `x-brust-ssg: 1` — the worker renders the placeholder shell only
 * for that header + all-sentinel params) into `_brust/fallback{,-page}/…`,
 * plus a `_brust/routes.json` manifest and a redirecting `404.html` (skipped
 * with a warning when the app ships its own `public/404.html`). Without
 * fallbacks the output is byte-identical to before this feature existed.
 *
 * Asset copy preserves the live server's URL shape: islands + css under
 * /_brust/, public/ root-mapped (runtime/index.ts configurePublicDir). */
export async function exportStatic(opts: {
  distDir: string // the just-built outDir
  entryDir: string // app dir (for public/)
  staticOut: string // e.g. dist/static (clobbered first)
  routes: SsgRouteDecision[]
  /** `fallback: 'client'` routes (pattern + built chunk URL) to emit shells for. */
  fallbacks?: Array<{ pattern: string; chunk: string }>
  /** True when the app declares a GLOBAL catch-all (notFoundPrefix === ''). The
   * crawler fetches an unmatched sentinel path (→ NotFound tier renders the
   * catch-all at 404) and writes its HTML to staticOut/404.html, composing the
   * fallback redirect script when fallbacks also exist. An app public/404.html
   * still wins. */
  globalNotFound?: boolean
}): Promise<{
  written: string[]
  navWritten: string[]
  fallbackWritten: string[]
  skipped: SsgRouteDecision[]
}> {
  const { distDir, entryDir, staticOut, routes, fallbacks = [], globalNotFound = false } = opts
  const included = routes.filter((r) => r.include)
  const skipped = routes.filter((r) => !r.include)

  await rm(staticOut, { recursive: true, force: true })
  await mkdir(staticOut, { recursive: true })

  const written: string[] = []
  const navWritten: string[] = []
  const fallbackWritten: string[] = []
  if (included.length > 0 || fallbacks.length > 0 || globalNotFound) {
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

        // SPA navigation payload — the document crawl above just proved this
        // route renders 200, so a failing payload is a real bug, not a host
        // quirk: fail the export rather than silently shipping full reloads.
        const navUrl = `/_brust/page${d.fullPath}`
        const navResp = await fetch(`http://127.0.0.1:${port}${navUrl}`, {
          headers: { Accept: 'application/json' },
        })
        const navBody = await navResp.text()
        if (navResp.status !== 200) {
          throw new Error(`GET ${navUrl} → ${navResp.status}\n${navBody.slice(0, 500)}`)
        }
        // Guard the payload contract the client navigator parses — a non-JSON
        // body would otherwise surface only as a runtime full-reload fallback.
        try {
          const parsed = JSON.parse(navBody) as { html?: unknown }
          if (typeof parsed.html !== 'string') throw new Error('missing "html" field')
        } catch (e) {
          throw new Error(`GET ${navUrl} → invalid SPA payload: ${(e as Error).message}`)
        }
        const navFile = navPayloadFileFor(d.fullPath)
        const navPath = join(staticOut, navFile)
        await mkdir(dirname(navPath), { recursive: true })
        await Bun.write(navPath, navBody)
        navWritten.push(navFile)
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

      // Fallback shells: crawl the sentinel path (every {param} →
      // __brust_fallback__) with the build-internal header that unlocks the
      // shell render. Same no-partial rule as the page crawl: any non-200
      // fails the whole export.
      for (const f of fallbacks) {
        const sentinel = fallbackSentinelPath(f.pattern)
        const resp = await fetch(`http://127.0.0.1:${port}${sentinel}`, {
          headers: { 'x-brust-ssg': '1' },
        })
        const body = await resp.text()
        if (resp.status !== 200) {
          throw new Error(`GET ${sentinel} → ${resp.status}\n${body.slice(0, 500)}`)
        }
        const docFile = join('_brust', 'fallback', fallbackDiskPath(f.pattern), 'index.html')
        const docPath = join(staticOut, docFile)
        await mkdir(dirname(docPath), { recursive: true })
        await Bun.write(docPath, body)
        fallbackWritten.push(docFile)

        // SPA payload of the shell — same {html,...} contract the client
        // navigator parses (attemptClientFallback swaps it into <main>).
        const payloadUrl = `/_brust/page${sentinel}`
        const payloadResp = await fetch(`http://127.0.0.1:${port}${payloadUrl}`, {
          headers: { 'x-brust-ssg': '1', Accept: 'application/json' },
        })
        const payloadBody = await payloadResp.text()
        if (payloadResp.status !== 200) {
          throw new Error(`GET ${payloadUrl} → ${payloadResp.status}\n${payloadBody.slice(0, 500)}`)
        }
        try {
          const parsed = JSON.parse(payloadBody) as { html?: unknown }
          if (typeof parsed.html !== 'string') throw new Error('missing "html" field')
        } catch (e) {
          throw new Error(`GET ${payloadUrl} → invalid SPA payload: ${(e as Error).message}`)
        }
        const payloadFile = join(
          '_brust',
          'fallback-page',
          fallbackDiskPath(f.pattern),
          'index.html',
        )
        const payloadPath = join(staticOut, payloadFile)
        await mkdir(dirname(payloadPath), { recursive: true })
        await Bun.write(payloadPath, payloadBody)
        fallbackWritten.push(payloadFile)
      }

      // Fallback {pattern, doc} pairs for the 404.html redirect script — also
      // inlined in the routes.json manifest. Empty when no fallback routes.
      const fallbackPairs = fallbacks.map((f) => ({
        pattern: f.pattern,
        doc: `/_brust/fallback/${fallbackDiskPath(f.pattern)}/`,
      }))

      if (fallbacks.length > 0) {
        // Manifest the client takeover runtime fetches to map a 404'd path to
        // its fallback shell. doc/payload are directory-index URLs (trailing
        // slash) so a dumb static host serves the index.html written above.
        const manifest = {
          version: 1,
          fallbacks: fallbacks.map((f) => ({
            pattern: f.pattern,
            doc: `/_brust/fallback/${fallbackDiskPath(f.pattern)}/`,
            payload: `/_brust/fallback-page/${fallbackDiskPath(f.pattern)}/`,
            chunk: f.chunk,
          })),
        }
        const manifestPath = join(staticOut, '_brust', 'routes.json')
        await mkdir(dirname(manifestPath), { recursive: true })
        await Bun.write(manifestPath, JSON.stringify(manifest))
      }

      // 404.html, single static-host slot. Resolution:
      //  - app public/404.html present → author owns it (lands via the public/
      //    copy below); never overwrite, warn only when it would have mattered.
      //  - GLOBAL catch-all → crawl an unmatched sentinel (NotFound tier renders
      //    the catch-all at 404), use its HTML as the document; inject the
      //    fallback redirect <script> when fallbacks ALSO exist (compose404Html).
      //  - fallbacks only → the minimal fallback404Html shell (unchanged).
      //  - neither → no framework 404.html (byte-identical-today).
      if (globalNotFound || fallbacks.length > 0) {
        if (existsSync(join(entryDir, 'public', '404.html'))) {
          console.warn(
            '[brust build] ssg: public/404.html exists — NOT overwriting; your 404 page must redirect fallback routes itself (see docs)',
          )
        } else if (globalNotFound) {
          // Crawl the global catch-all via an unmatched path: the dist server's
          // NotFound tier renders it at status 404. A non-404 here means the
          // catch-all isn't wired — fail the export rather than ship a wrong
          // (or 200) page as the 404.
          const resp = await fetch(`http://127.0.0.1:${port}${SSG_NOT_FOUND_SENTINEL_PATH}`)
          const body = await resp.text()
          if (resp.status !== 404) {
            throw new Error(
              `global catch-all crawl GET ${SSG_NOT_FOUND_SENTINEL_PATH} → ${resp.status} (expected 404)\n${body.slice(0, 500)}`,
            )
          }
          await Bun.write(join(staticOut, '404.html'), compose404Html(body, fallbackPairs))
        } else {
          await Bun.write(join(staticOut, '404.html'), fallback404Html(fallbackPairs))
        }
      }
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
  navWritten.sort()
  fallbackWritten.sort()
  return { written, navWritten, fallbackWritten, skipped }
}
