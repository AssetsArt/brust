// bench/apps/bun-serve/index.ts — one Bun.serve process of the no-framework ceiling (renderToString of the same
// pages; no cache, no hydration). `reusePort: true` lets N copies share the port (see cluster.ts). Each process counts
// the page requests it served and reports them on its own control port (GET /_count) so the runner can verify the
// kernel actually spread the load.
//   BENCH_PORT=38302 BENCH_CTRL_PORT=38352 bun bench/apps/bun-serve/index.ts
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import Page from './components/Page'
import { loadDex, TYPES } from './lib/data'
import DexPage from './pages/DexPage'
import TeamPage from './pages/TeamPage'
import TypesPage from './pages/TypesPage'

const HTML = { 'content-type': 'text/html; charset=utf-8' }
const page = (title: string, el: ReturnType<typeof createElement>) => new Response(`<!DOCTYPE html>${renderToString(createElement(Page, { title, children: el }))}`, { headers: HTML })
const typeNames = TYPES.map((t) => t.name)
let served = 0

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number.parseInt(process.env.BENCH_PORT ?? '38302', 10),
  reusePort: true,
  fetch(req) {
    const { pathname } = new URL(req.url)
    served++
    if (pathname === '/types') return page('Types · bench', createElement(TypesPage, { types: typeNames }))
    if (pathname === '/dex') return page('Pokédex · bench', createElement(DexPage, { rows: loadDex() }))
    if (pathname === '/team') return page('Team · bench', createElement(TeamPage))
    served--
    return new Response('not found', { status: 404 })
  },
})
const ctrl = process.env.BENCH_CTRL_PORT
  ? Bun.serve({ hostname: '127.0.0.1', port: Number.parseInt(process.env.BENCH_CTRL_PORT, 10), fetch: () => Response.json({ pid: process.pid, count: served }) })
  : null
console.log(`[bun-serve] listening on http://${server.hostname}:${server.port}`)
process.on('SIGINT', () => { server.stop(true); ctrl?.stop(true); process.exit(0) })
