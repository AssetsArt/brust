// The long-lived parent of `brust dev` for the Bun target (R13.1, R13.2): owns the user's port with
// `Bun.serve`, proxies to the active child (`brust start` on a loopback port), injects the dev client
// into every HTML response and serves the WebSocket the client listens on.
import { join } from 'node:path'
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
  onRequest(r: { method: string; path: string; status: number; ms: number; cache: string | null; trace: unknown | null }): void
  /** The active build's `dev.json` (L14), or null before the first build. */
  meta(): unknown | null
  /** F475: the active build's actions prefix, or null (no actions / before the first build). */
  actionsPrefix(): string | null
}

/** F475: the largest `max_stream_bytes` (4 GiB), what the proxy admits: Bun's own default for `maxRequestBodySize` is 128 MiB,
 * which would refuse a streamed upload the child itself admits. The child enforces the real ceilings (`max_body_bytes`,
 * `max_stream_bytes`), as in production. */
export const PROXY_MAX_BODY_BYTES = 2 ** 32

/** F529: is this a WebSocket handshake? A GET whose `Upgrade` header lists the `websocket` token. */
export function isWsUpgrade(req: Request): boolean {
  return req.method === 'GET' && (req.headers.get('upgrade') ?? '').split(',').some((t) => t.trim().toLowerCase() === 'websocket')
}

/** The close code a relayed socket's peer is told. A child that is going away (1001 from its drain, 1006 when it died, or its
 * own 1012) is a restart as far as the browser is concerned; a code a close frame may not carry becomes 1011, "no status" 1000. */
export function relayCloseCode(code: number, fromChild: boolean): number {
  if (fromChild && (code === 1001 || code === 1006 || code === 1012)) return 1012
  if (code === 1005) return 1000
  const valid = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
  return valid ? code : fromChild ? 1011 : 1000
}

/** The status the child answered a refused upgrade with, read from the client's error text ("Expected 101 status code: 401"); 502 when it never answered. */
export function refusedStatus(message: string): number {
  const m = /Expected 101 status code: (\d{3})/.exec(message)
  const n = m ? Number(m[1]) : 0
  return n >= 400 && n <= 599 ? n : 502
}

/** Headers of the handshake that belong to a single hop; everything else (cookies, `Origin`, `Host`, auth) goes to the child as the browser sent it. */
const WS_HOP_HEADERS = new Set(['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'sec-websocket-accept', 'content-length', 'transfer-encoding', 'accept-encoding'])

/** Is `pathname` the actions prefix or under it? (`/` = everything.) */
export function underPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** One entry of the dev trace list (`/_brust/dev/traces`, newest last, at most [`MAX_TRACES`]). */
export interface TraceEntry {
  id: number
  at: number
  kind: 'page' | 'action' | 'request'
  method: string
  path: string
  status: number
  ms: number
  /** The core's trace (`x-brust-dev`), pages only. */
  trace: unknown | null
}
export const MAX_TRACES = 50

/** What a proxy socket carries: nothing for the dev-channel clients, the upstream leg for a relayed app socket (F529 D12). */
export type SocketData = undefined | Relay

/** One relayed app WebSocket: the browser's socket (`ws`, set at `open`) and the child's (`up`). Frames the child sends before
 * the browser socket is open wait in `pending`. */
interface Relay {
  up: WebSocket
  ws: ServerWebSocket<SocketData> | null
  pending: (string | ArrayBuffer | { close: number; reason: string })[]
}

export interface DevProxy {
  server: Server<SocketData>
  port: number
  /** The last [`MAX_TRACES`] traced requests, oldest first. */
  traces(): TraceEntry[]
  /** Send to every connected browser. */
  broadcast(msg: Record<string, unknown>): void
  clients(): number
  stop(): void
}

export const CLIENT_PATH = '/_brust/dev/client.js'
export const WS_PATH = '/_brust/dev/ws'
export const DEVTOOLS_PATH = '/_brust/dev/devtools.js'
export const TRACES_PATH = '/_brust/dev/traces'
export const META_PATH = '/_brust/dev/meta'
/** F495: the dev channel's URLs for an app mounted under `base` (`''` = the root): the page's scripts and the WebSocket connect under it. */
export const devPaths = (base = '') => ({ client: `${base}${CLIENT_PATH}`, ws: `${base}${WS_PATH}`, devtools: `${base}${DEVTOOLS_PATH}`, traces: `${base}${TRACES_PATH}`, meta: `${base}${META_PATH}` })
const scriptTag = (gen: number, base = '') => `<script type="module" src="${devPaths(base).client}?g=${gen}"></script><script type="module" src="${devPaths(base).devtools}"></script>`

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** `html` with the dev client script before `</head>` (else at the end). */
export function inject(html: string, gen: number, trace: unknown | null = null, base = ''): string {
  const tag = scriptTag(gen, base) + (trace ? traceTag(trace) : '')
  const i = html.search(/<\/head\s*>/i)
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag
}

function isDocument(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const dest = req.headers.get('sec-fetch-dest')
  if (dest) return dest === 'document'
  return (req.headers.get('accept') ?? '').includes('text/html')
}

/** `<script type=application/json id=__brust_trace>` for a traced page (`<` escaped: it cannot close the tag). */
const traceTag = (trace: unknown) => `<script type="application/json" id="__brust_trace">${JSON.stringify(trace).replace(/</g, '\\u003c')}</script>`

/** The core's `x-brust-dev` header (base64 of JSON) → the trace object; null when absent or malformed. */
export function decodeTrace(h: string | null): unknown | null {
  if (!h) return null
  try {
    return JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** A small HTML page (so even a plain-text 5xx or "no child yet" carries the client script). */
function htmlPage(status: number, title: string, body: string, gen: number, trace: unknown | null = null, base = ''): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${scriptTag(gen, base)}${trace ? traceTag(trace) : ''}</head><body style="font:14px ui-monospace,monospace;padding:24px"><h1>${esc(title)}</h1><pre style="white-space:pre-wrap">${esc(body)}</pre></body></html>`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** The `Host` names the dev server answers to (DNS-rebinding guard): loopback, the configured bind host, and
 * `BRUST_DEV_ALLOWED_HOSTS` (comma separated) for a tunnel or a custom local name. */
export function allowedHosts(bind: string, extra: string | undefined): Set<string> {
  return new Set([...LOOPBACK, bind.toLowerCase(), ...(extra ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)])
}

const hostName = (hostHeader: string): string => {
  const h = hostHeader.toLowerCase()
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : (h.split(':')[0] ?? '')
}

/** A WebSocket (or any request) from a page of ANOTHER origin must not reach the dev channel: `Origin`, when sent,
 * has to be the host the request was addressed to. */
export function sameOriginOrNone(origin: string | null, hostHeader: string | null): boolean {
  if (origin === null) return true
  try {
    return new URL(origin).host.toLowerCase() === (hostHeader ?? '').toLowerCase()
  } catch {
    return false
  }
}

let devtoolsJs: Promise<string> | null = null
/** `<brust-devtools>` (L15), bundled from `devtools.ts` on first request and kept: it is only ever served by this proxy. */
function devtoolsBundle(): Promise<string> {
  devtoolsJs ??= Bun.build({ entrypoints: [join(import.meta.dir, 'devtools.ts')], target: 'browser', format: 'esm', minify: false }).then(async (r) => {
    const out = r.outputs[0]
    if (!r.success || !out) throw new Error(`devtools bundle failed: ${r.logs.map(String).join('\n')}`)
    return out.text()
  })
  return devtoolsJs
}

/** The trace a proxied response carried (read by `onRequest`; the header itself never reaches the browser). */
const traceOf = new WeakMap<Response, unknown>()

export function startProxy(o: { hostname: string; port: number; allowedHosts?: string; token: string; basePath?: string }, view: DevView): DevProxy {
  const base = o.basePath ?? ''
  const P = devPaths(base)
  const traces: TraceEntry[] = []
  let seq = 0
  const allowed = allowedHosts(o.hostname, o.allowedHosts ?? process.env.BRUST_DEV_ALLOWED_HOSTS)
  const sockets = new Set<ServerWebSocket<SocketData>>()
  const send = (ws: ServerWebSocket<SocketData>, msg: unknown) => {
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
      return htmlPage(503, d ? `brust dev: ${d.rule}` : 'brust dev: building…', d?.raw ?? 'The first build is running. This page reloads when it is ready.', gen, null, base)
    }
    const headers = new Headers(req.headers)
    // The token only this proxy knows: whatever a browser sent under that name is overwritten.
    headers.set('x-brust-dev-token', o.token)
    const t0 = performance.now()
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
      return htmlPage(502, 'brust dev: the server is not reachable', String((e as Error).message ?? e), gen, null, base)
    }
    const out = new Headers(res.headers)
    // The trace never reaches the browser as a header: it travels in the page (`#__brust_trace`) and `/_brust/dev/traces`.
    const trace = decodeTrace(res.headers.get('x-brust-dev'))
    out.delete('x-brust-dev')
    const isAction = req.method !== 'GET' && req.method !== 'HEAD' ? true : url.pathname.startsWith(`${base}/_brust/action`)
    if (trace || isAction) {
      traces.push({ id: ++seq, at: Date.now(), kind: trace ? 'page' : 'action', method: req.method, path: url.pathname + url.search, status: res.status, ms: Math.round(performance.now() - t0), trace })
      if (traces.length > MAX_TRACES) traces.shift()
    }
    const tag = (r: Response) => (traceOf.set(r, trace), r)
    out.set('cache-control', 'no-store')
    out.delete('content-length')
    out.delete('content-encoding')
    const loc = out.get('location')
    if (loc) out.set('location', loc.replace(`http://127.0.0.1:${port}`, url.origin))
    const type = res.headers.get('content-type') ?? ''
    if (req.method === 'HEAD' || res.status === 204 || res.status === 304) return new Response(null, { status: res.status, headers: out })
    if (/text\/html/i.test(type)) {
      out.set('content-type', type)
      return tag(new Response(inject(await res.text(), gen, trace, base), { status: res.status, headers: out }))
    }
    if (doc && res.status >= 500) return tag(htmlPage(res.status, `${res.status} ${res.statusText || 'server error'}`, await res.text(), gen, trace, base))
    return tag(new Response(res.body, { status: res.status, headers: out }))
  }

  /** F529 D12: relay a WebSocket upgrade under the actions prefix to the child. The child's handshake runs first, so its refusal (a
   * guard's 401, the cross-site 403) reaches the browser as the HTTP status it is, not as a socket that opens and closes. */
  async function relay(req: Request, srv: Server<SocketData>, port: number): Promise<Response | undefined> {
    const url = new URL(req.url)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      if (!WS_HOP_HEADERS.has(k.toLowerCase())) headers[k] = v
    })
    headers['x-brust-dev-token'] = o.token
    const r: Relay = { up: undefined as unknown as WebSocket, ws: null, pending: [] }
    let up: WebSocket
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Bun's WebSocket accepts request headers (Host, Origin, Cookie)
      up = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, { headers } as any)
    } catch (e) {
      return new Response(`brust dev: ${String((e as Error).message ?? e)}`, { status: 502 })
    }
    up.binaryType = 'arraybuffer'
    r.up = up
    const opened = await new Promise<string | null>((resolve) => {
      up.onopen = () => resolve(null)
      up.onerror = (e) => resolve((e as ErrorEvent).message || 'upstream connection failed')
      up.onclose = () => resolve('upstream closed during the handshake')
    })
    if (opened !== null) return new Response(`brust dev: the server refused the WebSocket upgrade (${opened})`, { status: refusedStatus(opened) })
    const toBrowser = (m: Relay['pending'][number]) => {
      if (r.ws === null) return void r.pending.push(m)
      try {
        if (typeof m === 'object' && 'close' in m) r.ws.close(m.close, m.reason)
        else r.ws.send(m)
      } catch {}
    }
    up.onmessage = (e) => toBrowser(e.data as string | ArrayBuffer)
    up.onclose = (e) => {
      toBrowser({ close: relayCloseCode(e.code, true), reason: relayCloseCode(e.code, true) === 1012 ? 'service restart' : e.reason })
    }
    up.onerror = () => {}
    if (!srv.upgrade(req, { data: r })) {
      up.close()
      return new Response('websocket expected', { status: 426 })
    }
    return undefined
  }

  const server = Bun.serve<SocketData>({
    hostname: o.hostname,
    port: o.port,
    maxRequestBodySize: PROXY_MAX_BODY_BYTES,
    async fetch(req, srv) {
      const url = new URL(req.url)
      // F475: a body-carrying call under the actions prefix may be a streamed upload that pauses or runs for minutes; Bun's
      // 10 s idle timeout would cut it. The child owns the real bounds (`stream_idle_ms`, `stream_total_ms`).
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null) {
        const prefix = view.actionsPrefix()
        if (prefix !== null && underPrefix(url.pathname, prefix)) srv.timeout(req, 0)
      }
      // DNS rebinding: a page on evil.example whose name resolves to 127.0.0.1 would otherwise read the app and the
      // source paths in build errors. Only the dev server's own names are answered.
      if (!allowed.has(hostName(req.headers.get('host') ?? ''))) return new Response('brust dev: unexpected Host header (set BRUST_DEV_ALLOWED_HOSTS to allow it)', { status: 421 })
      if (url.pathname === P.ws && !sameOriginOrNone(req.headers.get('origin'), req.headers.get('host'))) return new Response('brust dev: cross-origin WebSocket refused', { status: 403 })
      if (url.pathname === P.ws) return srv.upgrade(req, { data: undefined }) ? undefined : new Response('websocket expected', { status: 426 })
      // F529 D12: an app WebSocket (actions prefix) is relayed to the child; the Origin rule is the dev channel's own.
      if (isWsUpgrade(req)) {
        const prefix = view.actionsPrefix()
        if (prefix !== null && underPrefix(url.pathname, prefix)) {
          if (!sameOriginOrNone(req.headers.get('origin'), req.headers.get('host'))) return new Response('brust dev: cross-origin WebSocket refused', { status: 403 })
          const port = view.upstream()
          if (port === null) return new Response('brust dev: building…', { status: 503 })
          return relay(req, srv, port)
        }
        // Not an actions path: the child has no WebSocket there either (and a proxied 101 would open a socket nothing serves).
        return new Response('brust dev: WebSocket upgrades are only supported under the actions prefix', { status: 426 })
      }
      if (url.pathname === P.traces) return Response.json({ traces }, { headers: { 'cache-control': 'no-store' } })
      if (url.pathname === P.meta) return Response.json(view.meta() ?? {}, { headers: { 'cache-control': 'no-store' } })
      if (url.pathname === P.devtools) {
        return devtoolsBundle().then(
          (js) => new Response(js, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } }),
          (e: Error) => new Response(e.message, { status: 500 }),
        )
      }
      if (url.pathname === P.client) return new Response(DEV_CLIENT_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
      const t0 = performance.now()
      const res = await forward(req)
      view.onRequest({ method: req.method, path: url.pathname + url.search, status: res.status, ms: Math.round(performance.now() - t0), cache: res.headers.get('x-brust-cache'), trace: traceOf.get(res) ?? null })
      return res
    },
    websocket: {
      open(ws) {
        const r = ws.data
        if (r) {
          r.ws = ws
          for (const m of r.pending.splice(0)) {
            if (typeof m === 'object' && 'close' in m) ws.close(m.close, m.reason)
            else ws.send(m)
          }
          return
        }
        sockets.add(ws)
        send(ws, hello())
      },
      close(ws, code, reason) {
        const r = ws.data
        if (r) {
          if (r.up.readyState === WebSocket.OPEN || r.up.readyState === WebSocket.CONNECTING) r.up.close(relayCloseCode(code, false), reason)
          return
        }
        sockets.delete(ws)
      },
      message(ws, msg) {
        const r = ws.data
        if (r && r.up.readyState === WebSocket.OPEN) r.up.send(msg)
      },
    },
  })
  return {
    server,
    port: server.port ?? o.port,
    broadcast(msg) {
      for (const ws of sockets) send(ws, msg)
    },
    traces: () => traces,
    clients: () => sockets.size,
    stop: () => void server.stop(true),
  }
}
