// The child process `brust build --target static` renders in (gaps round L9): boots the real server
// on loopback with the normal workers (`run()`, so every byte is what `brust start` sends), fetches
// each planned path, writes the responses to `BRUST_SSG_OUT`, then drains. A child process, because
// the napi server is a per-process singleton. Input: `BRUST_SSG_PLAN` (a JSON list of paths).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { run } from '../run'

export interface Rendered {
  path: string
  status: number
  headers: Record<string, string>
  /** base64 */
  body: string
}

/** A page that did not answer within the per-page limit (review N3). */
export class PageTimeout extends Error {
  constructor(
    readonly path: string,
    readonly ms: number,
  ) {
    super(`GET ${path} did not answer within ${ms} ms`)
  }
}

/** The seam an in-process host can replace later: GET each path from `base`, uncompressed, no redirect
 * following, each within `pageMs` (`PageTimeout`). `started` hears each path before it is requested. */
export async function renderPaths(base: string, paths: string[], pageMs = 30_000, started: (path: string) => void = () => {}): Promise<Rendered[]> {
  const out: Rendered[] = []
  for (const path of paths) {
    started(path)
    const signal = AbortSignal.timeout(pageMs)
    try {
      const r = await fetch(base + path, { redirect: 'manual', headers: { 'accept-encoding': 'identity' }, signal })
      out.push({ path, status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()).toString('base64') })
    } catch (e) {
      if (signal.aborted) throw new PageTimeout(path, pageMs)
      throw e
    }
  }
  return out
}

if (import.meta.main) {
  const env = process.env
  const paths = JSON.parse(readFileSync(env.BRUST_SSG_PLAN!, 'utf8')) as string[]
  await run({
    distDir: env.BRUST_DIST_DIR,
    entry: env.BRUST_APP_ENTRY,
    config: { host: '127.0.0.1', port: 0 },
    onReady: async (addr) => {
      const pageMs = Number(env.BRUST_SSG_PAGE_TIMEOUT_MS) || 30_000
      const progress = env.BRUST_SSG_PROGRESS
      try {
        const pages = await renderPaths(`http://${addr}`, paths, pageMs, (p) => progress && appendFileSync(progress, `${p}\n`))
        writeFileSync(env.BRUST_SSG_OUT!, JSON.stringify({ addr, pages }))
        return 0
      } catch (e) {
        if (!(e instanceof PageTimeout)) throw e
        writeFileSync(env.BRUST_SSG_OUT!, JSON.stringify({ addr, timeout: { path: e.path, ms: e.ms } }))
        return 1
      }
    },
  })
}
