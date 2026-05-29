// Baseline comparator: Bun.serve() + React renderToString.
// Same Bun runtime, same React, same shared HelloWorld component as the Brust
// bench app. Measures the pure JS-side ceiling — anywhere Brust beats this, the
// win is from napi+Rust+SAB+keep-alive (and not from runtime differences).
//
// Run from repo root:  bun run bench/apps/bun-serve/index.ts
// Override port:       BUN_BASELINE_PORT=3001 bun run bench/apps/bun-serve/index.ts

import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import HelloWorld from '../_shared/HelloWorld'

const port = parseInt(process.env.BUN_BASELINE_PORT ?? '3001', 10)

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/ping') {
      return new Response('pong\n', {
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    const html = renderToString(
      createElement(HelloWorld, { workerId: 0 } as any),
    )
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  },
})

console.log(`[bun-baseline] listening on http://${server.hostname}:${server.port}`)
