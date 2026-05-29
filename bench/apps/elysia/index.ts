// Baseline comparator: Elysia (on Bun) + React renderToString.
// Same Bun runtime, same React, same shared HelloWorld component as the Brust
// bench app and the bun-serve baseline. Measures Elysia's routing overhead vs
// raw Bun.serve and vs Brust's Rust HTTP layer.
//
// Run from repo root:  bun run bench/apps/elysia/index.ts
// Override port:       ELYSIA_PORT=3003 bun run bench/apps/elysia/index.ts

import { Elysia } from 'elysia'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import HelloWorld from '../_shared/HelloWorld'

const port = parseInt(process.env.ELYSIA_PORT ?? '3003', 10)

new Elysia()
  .get('/ping', () => new Response('pong\n', { headers: { 'Content-Type': 'text/plain' } }))
  .get('/', () => {
    const html = renderToString(createElement(HelloWorld, { workerId: 0 } as any))
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  })
  .listen(port, (server) => {
    console.log(`[elysia] listening on http://${server.hostname}:${server.port}`)
  })
