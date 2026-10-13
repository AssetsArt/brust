// The child process `brust build --target static` renders in (gaps round L9): boots the real server
// on loopback with the normal workers (`run()`, so every byte is what `brust start` sends), fetches
// each planned path, writes the responses to `BRUST_SSG_OUT`, then drains. A child process, because
// the napi server is a per-process singleton. Input: `BRUST_SSG_PLAN` (a JSON list of paths).
import { readFileSync, writeFileSync } from 'node:fs'
import { run } from '../run'

export interface Rendered {
  path: string
  status: number
  headers: Record<string, string>
  /** base64 */
  body: string
}

/** The seam an in-process host can replace later: GET each path from `base`, uncompressed, no redirect following. */
export async function renderPaths(base: string, paths: string[]): Promise<Rendered[]> {
  const out: Rendered[] = []
  for (const path of paths) {
    const r = await fetch(base + path, { redirect: 'manual', headers: { 'accept-encoding': 'identity' } })
    out.push({ path, status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()).toString('base64') })
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
      writeFileSync(env.BRUST_SSG_OUT!, JSON.stringify({ addr, pages: await renderPaths(`http://${addr}`, paths) }))
      return 0
    },
  })
}
