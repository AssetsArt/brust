// bench/apps/bun-serve/index.ts — the no-framework ceiling: Bun.serve + react-dom/server renderToString of the
// same pages. No cache, no hydration script, no islands: whatever brust loses to this is framework cost.
//   BENCH_PORT=38202 bun bench/apps/bun-serve/index.ts
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

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number.parseInt(process.env.BENCH_PORT ?? '38202', 10),
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/types') return page('Types · bench', createElement(TypesPage, { types: typeNames }))
    if (pathname === '/dex') return page('Pokédex · bench', createElement(DexPage, { rows: loadDex() }))
    if (pathname === '/team') return page('Team · bench', createElement(TeamPage))
    return new Response('not found', { status: 404 })
  },
})
console.log(`[bun-serve] listening on http://${server.hostname}:${server.port}`)
process.on('SIGINT', () => { server.stop(true); process.exit(0) })
