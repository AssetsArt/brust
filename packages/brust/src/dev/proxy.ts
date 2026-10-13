// The long-lived parent of `brust dev` for the Bun target (R13.1, R13.2): owns the user's port with
// `Bun.serve`, proxies to the active child (`brust start` on a loopback port), injects the dev client
// into every HTML response and serves the WebSocket the client listens on.
import type { Server, ServerWebSocket } from 'bun'
import { DEV_CLIENT_JS } from './client'
import type { Diag } from './diag'
import type { DevState } from './tui'

export interface DevView {
  gen(): number
  state(): DevState
  diag(): Diag | null
  /** The active child's loopback port; null before the first successful boot. */
  upstream(): number | null
  onRequest(r: { method: string; path: string; status: number; ms: number; cache: string | null }): void
}

export interface DevProxy {
  server: Server<undefined>
  port: number
  /** Send to every connected browser. */
  broadcast(msg: Record<string, unknown>): void
  clients(): number
  stop(): void
}

export const CLIENT_PATH = '/_brust/dev/client.js'
export const WS_PATH = '/_brust/dev/ws'
const scriptTag = (gen: number) => `<script type="module" src="${CLIENT_PATH}?g=${gen}"></script>`

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** `html` with the dev client script before `</head>` (else at the end). */
export function inject(html: string, gen: number): string {
  const tag = scriptTag(gen)
  const i = html.search(/<\/head\s*>/i)
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag
}

function isDocument(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const dest = req.headers.get('sec-fetch-dest')
  if (dest) return dest === 'document'
  return (req.headers.get('accept') ?? '').includes('text/html')
}

/** A small HTML page (so even a plain-text 5xx or "no child yet" carries the client script). */
function htmlPage(status: number, title: string, body: string, gen: number): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${scriptTag(gen)}</head><body style="font:14px ui-monospace,monospace;padding:24px"><h1>${esc(title)}</h1><pre style="white-space:pre-wrap">${esc(body)}</pre></body></html>`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

export function startProxy(o: { hostname: string; port: number }, view: DevView): DevProxy {
  const sockets = new Set<ServerWebSocket<undefined>>()
  const send = (ws: ServerWebSocket<undefined>, msg: unknown) => {
    try {
      ws.send(JSON.stringify(msg))
    } catch {}
  }
  const hello = () => ({ type: 'hello', gen: view.gen(), state: view.state(), diag: view.state() === 'error' ? view.diag() : null })

  async function forward(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const gen = view.gen()
    const doc = isDocument(req)
    const port = view.upstream()
    if (port === null) {
      const d = view.diag()
      return htmlPage(503, d ? `brust dev: ${d.rule}` : 'brust dev: building…', d?.raw ?? 'The first build is running. This page reloads when it is ready.', gen)
    }
    const headers = new Headers(req.headers)
    // Injection needs an identity body; `Host` and `Origin` are kept as the browser sent them (the actions cross-site guard reads both).
    headers.set('accept-encoding', 'identity')
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
        redirect: 'manual',
        // biome-ignore lint/suspicious/noExplicitAny: Bun's fetch option
      } as any)
    } catch (e) {
      return htmlPage(502, 'brust dev: the server is not reachable', String((e as Error).message ?? e), gen)
    }
    const out = new Headers(res.headers)
    out.set('cache-control', 'no-store')
    out.delete('content-length')
    out.delete('content-encoding')
    const loc = out.get('location')
    if (loc) out.set('location', loc.replace(`http://127.0.0.1:${port}`, url.origin))
    const type = res.headers.get('content-type') ?? ''
    if (req.method === 'HEAD' || res.status === 204 || res.status === 304) return new Response(null, { status: res.status, headers: out })
    if (/text\/html/i.test(type)) {
      out.set('content-type', type)
      return new Response(inject(await res.text(), gen), { status: res.status, headers: out })
    }
    if (doc && res.status >= 500) return htmlPage(res.status, `${res.status} ${res.statusText || 'server error'}`, await res.text(), gen)
    return new Response(res.body, { status: res.status, headers: out })
  }

  const server = Bun.serve<undefined>({
    hostname: o.hostname,
    port: o.port,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === WS_PATH) return srv.upgrade(req, { data: undefined }) ? undefined : new Response('websocket expected', { status: 426 })
      if (url.pathname === CLIENT_PATH) return new Response(DEV_CLIENT_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
      const t0 = performance.now()
      const res = await forward(req)
      view.onRequest({ method: req.method, path: url.pathname + url.search, status: res.status, ms: Math.round(performance.now() - t0), cache: res.headers.get('x-brust-cache') })
      return res
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        send(ws, hello())
      },
      close(ws) {
        sockets.delete(ws)
      },
      message() {},
    },
  })
  return {
    server,
    port: server.port ?? o.port,
    broadcast(msg) {
      for (const ws of sockets) send(ws, msg)
    },
    clients: () => sockets.size,
    stop: () => void server.stop(true),
  }
}
