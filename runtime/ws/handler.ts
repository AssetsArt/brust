import type { Route, BrustRequest, RouteCall, WsHandlers, WsSocket } from '../routes.ts'

export type WsCall = Extract<RouteCall, { kind: 'ws' }>

/** NAPI surface — Rust provides these. Tests use a mock. */
export interface WsNapi {
  send(conn_id: bigint, data: Uint8Array, isBinary: boolean): Promise<void>
  close(conn_id: bigint, code: number, reason: string): void
  signalOpen(conn_id: bigint, status: number, body: string, contentType: string, subprotocol: string): void
  registerHandlers(
    conn_id: bigint,
    onMessage: (data: Uint8Array, isBinary: boolean) => void,
    onClose: (code: number, reason: string) => void,
  ): void
}

/** Pick the first subprotocol from `routeList` that the client also requested.
 * Returns null when there's no overlap or routeList is empty/undefined. */
export function pickSubprotocol(
  clientList: string[],
  routeList: string[] | undefined,
): string | null {
  if (!routeList || routeList.length === 0) return null
  for (const candidate of routeList) {
    if (clientList.includes(candidate)) return candidate
  }
  return null
}

class WsSocketImpl implements WsSocket {
  constructor(
    public readonly id: bigint,
    private napi: WsNapi,
    private closed: { v: boolean },
  ) {}

  async send(data: string | Uint8Array): Promise<void> {
    if (this.closed.v) throw new Error(`ws conn ${this.id}: already closed`)
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    const isBinary = typeof data !== 'string'
    await this.napi.send(this.id, bytes, isBinary)
  }

  close(code: number = 1000, reason: string = ''): void {
    if (this.closed.v) return
    this.closed.v = true
    this.napi.close(this.id, code, reason.slice(0, 123))
  }
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

/**
 * Per-connection JS driver for WebSocket routes. Caller (wsBranch) is
 * responsible for running middleware FIRST and only invoking this on a 101
 * verdict — the signalOpen call here is always 101.
 *
 * Ordering note: handlers.open is *called* before any message can fire,
 * but if open is async it is NOT guaranteed to *complete* before the first
 * message arrives. Handlers that initialise per-connection state in open
 * and read it in message should await any setup synchronously inside open,
 * or guard reads in message against missing state.
 */
export async function handleWsConn(
  call: WsCall,
  route: Route,
  napi: WsNapi,
): Promise<void> {
  // Load the handler module. Failure here → 500 signalOpen (Rust writes
  // regular HTTP error response since 101 hasn't been sent yet).
  //
  // Accept either a direct WsHandlers object OR a module wrapper exposing
  // the handlers via `default`. The latter is what `() => import('./x.ts')`
  // produces, which is the most common author pattern — refusing it would
  // silently no-op the handler (no method on the module-namespace object
  // matches WsHandlers' method names).
  let handlers: WsHandlers
  try {
    const loaded = await route.websocket!()
    const maybeDefault = (loaded as { default?: WsHandlers }).default
    handlers = (maybeDefault && typeof maybeDefault === 'object') ? maybeDefault : (loaded as WsHandlers)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    napi.signalOpen(call.conn_id, 500, `ws handler import failed: ${msg}`, 'text/plain; charset=utf-8', '')
    return
  }

  // Pick subprotocol (route declares; client requests; first match wins).
  const chosen = pickSubprotocol(call.client_subprotocols, route.wsOptions?.subprotocols)

  // CRITICAL ORDERING: register handlers BEFORE signalOpen(101). Once
  // signalOpen fires, Rust writes the 101 response, the client sees
  // OPEN immediately, and may send frames that hit ws_conn_task's
  // on_message lookup. If on_message is still None at that point the
  // frame is silently dropped. Build the socket + install handlers
  // first; only then unblock Rust by signalling 101.
  const closed = { v: false }
  const socket = new WsSocketImpl(call.conn_id, napi, closed)

  napi.registerHandlers(
    call.conn_id,
    (data, isBinary) => {
      const payload = isBinary ? data : decoder.decode(data)
      try {
        const r = handlers.message?.(socket, payload)
        if (r instanceof Promise) r.catch((err) => {
          console.error(`[brust] ws conn=${call.conn_id} message handler rejected:`, err)
        })
      } catch (err) {
        console.error(`[brust] ws conn=${call.conn_id} message handler threw:`, err)
      }
    },
    (code, reason) => {
      closed.v = true
      try {
        handlers.close?.(socket, code, reason)
      } catch (err) {
        console.error(`[brust] ws conn=${call.conn_id} close handler threw:`, err)
      }
    },
  )

  napi.signalOpen(call.conn_id, 101, '', '', chosen ?? '')

  // Fire author's open hook. Throws here close the conn 1011.
  if (handlers.open) {
    try {
      const r = handlers.open(socket, { req: call.req, subprotocol: chosen })
      if (r instanceof Promise) {
        r.catch((err) => {
          console.error(`[brust] ws conn=${call.conn_id} open handler rejected:`, err)
          if (!closed.v) socket.close(1011, 'internal error')
        })
      }
    } catch (err) {
      console.error(`[brust] ws conn=${call.conn_id} open handler threw:`, err)
      if (!closed.v) socket.close(1011, 'internal error')
    }
  }
}
