// F529 (ws-adapter, plan §2d): the worker side of `Elysia .ws()` under the `brust()` adapter. Rust owns the sockets
// (handshake, frames, ping/pong, limits, topics); this file only runs the user's handlers. No elysia import: the
// handler it drives is whatever `provider.buildGlobalWSHandler()` returned (a Bun-style `{open, message, drain, close,
// ping, pong}`), so the bridge can import it without pulling elysia into a worker that has no `[actions]`.
//
//   upgrade (fetch call)   Elysia's route calls `app.server.upgrade(req, {headers, data})` → `shim.upgrade` records
//                          the accept for that Request; `runFetch` turns `res === undefined` into A2 `{status:101, ws}`.
//   socket events          Rust → `registerSockets` dispatcher → the Elysia global handler, with a `ServerWebSocket`
//                          that forwards send/close/subscribe/publish to the napi calls of plan §2c.
import { AsyncLocalStorage } from 'node:async_hooks'
import { native as addon } from '../native'

/** Plan §2c — the napi surface the adapter consumes (`crates/brust-napi`, task ws-napi). Every call is synchronous and
 * takes `(workerId, localId, …)`; the exceptions are `registerSockets` and the server-level `wsPublish`. */
export type SocketEventName = 'open' | 'message' | 'drain' | 'close' | 'ping' | 'pong'
export type SocketEventFn = (localId: number, ev: SocketEventName, data: string | Buffer | null, code: number, reason: string) => Promise<void> | void
export interface WsNative {
  registerSockets(workerId: number, fn: SocketEventFn): void
  wsSend(workerId: number, localId: number, data: string | Buffer): number
  wsClose(workerId: number, localId: number, code: number, reason: string): void
  wsTerminate(workerId: number, localId: number): void
  wsSubscribe(workerId: number, localId: number, topic: string): boolean
  wsUnsubscribe(workerId: number, localId: number, topic: string): boolean
  wsIsSubscribed(workerId: number, localId: number, topic: string): boolean
  wsSubscriptions(workerId: number, localId: number): string[]
  wsPing(workerId: number, localId: number, data?: Buffer): void
  wsPong(workerId: number, localId: number, data?: Buffer): void
  wsRemoteAddress(workerId: number, localId: number): string
  wsPublish(topic: string, data: string | Buffer, exceptWorkerId?: number, exceptLocalId?: number): number
}

/** A2 `ws` (plan §2a): what a 101 carries to Rust. Options are Elysia's own names, in Elysia's units (seconds, bytes). */
export interface WsMeta {
  id: number
  maxPayload?: number
  idleTimeout?: number
  backpressureLimit?: number
  closeOnBackpressureLimit?: boolean
  publishToSelf?: boolean
  sendPings?: boolean
}

/** The Bun-style handler Elysia builds (`buildGlobalWSHandler`). */
export interface WsHandler {
  open?(ws: BrustSocket): void
  message?(ws: BrustSocket, message: string | Buffer): void
  drain?(ws: BrustSocket): void
  close?(ws: BrustSocket, code: number, reason: string): void
  ping?(ws: BrustSocket, data: Buffer): void
  pong?(ws: BrustSocket, data: Buffer): void
}

// ---- native seam ----

let nativeOverride: WsNative | null = null
/** Tests swap the binding with this (like `setNative` in native.ts); `null` restores the addon. */
export function setWsNative(n: WsNative | null): void {
  nativeOverride = n
}
function native(): WsNative {
  // `addon()` loads the binding lazily: importing the adapter never needs the addon (a build imports routes).
  return nativeOverride ?? (addon() as unknown as WsNative)
}

let currentWorker = 0

// ---- sockets ----

type BufferSource = ArrayBufferView | ArrayBufferLike
type Snapshot = <R>(fn: () => R) => R
const noop = () => {}
const isView = (d: unknown): d is ArrayBufferView => ArrayBuffer.isView(d)

function toWire(d: string | BufferSource): string | Buffer {
  if (typeof d === 'string') return d
  if (isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength)
  return Buffer.from(d as ArrayBuffer)
}

/** The Bun `ServerWebSocket` Elysia's `ElysiaWS` wraps (plan §2d). `data` is the object Elysia passed to `upgrade`. */
export class BrustSocket {
  readyState: 0 | 1 | 2 | 3 = 0
  binaryType: 'nodebuffer' | 'arraybuffer' | 'uint8array' = 'nodebuffer'
  #remote: string | undefined
  /** The promise the last handler call returned (the dispatcher hands it to Rust as the back-pressure signal). */
  pending: Promise<unknown> | undefined
  constructor(
    readonly localId: number,
    readonly data: Record<string, any>,
    readonly meta: WsMeta,
    /** D11: the async context of the upgrade request, re-entered for every event. */
    readonly run: Snapshot,
    readonly createdAt = Date.now(),
  ) {}

  get remoteAddress(): string {
    return (this.#remote ??= native().wsRemoteAddress(currentWorker, this.localId))
  }
  get subscriptions(): string[] {
    return this.readyState > 1 ? [] : native().wsSubscriptions(currentWorker, this.localId)
  }

  send(data: string | BufferSource, _compress?: boolean): number {
    if (this.readyState !== 1) return 0
    return native().wsSend(currentWorker, this.localId, toWire(data))
  }
  sendText(data: string, compress?: boolean): number {
    return this.send(data, compress)
  }
  sendBinary(data: BufferSource, compress?: boolean): number {
    return this.send(data, compress)
  }
  close(code?: number, reason?: string): void {
    if (this.readyState > 1) return
    this.readyState = 2
    native().wsClose(currentWorker, this.localId, code ?? 1000, reason ?? '')
  }
  terminate(): void {
    if (this.readyState > 1) return
    this.readyState = 2
    native().wsTerminate(currentWorker, this.localId)
  }
  ping(data?: string | BufferSource): number {
    if (this.readyState !== 1) return 0
    native().wsPing(currentWorker, this.localId, data === undefined ? undefined : Buffer.from(toWire(data)))
    return 1
  }
  pong(data?: string | BufferSource): number {
    if (this.readyState !== 1) return 0
    native().wsPong(currentWorker, this.localId, data === undefined ? undefined : Buffer.from(toWire(data)))
    return 1
  }
  /** Bun: a publish skips the publishing socket unless `publishToSelf`. */
  publish(topic: string, data: string | BufferSource, _compress?: boolean): number {
    if (this.readyState !== 1) return 0
    const self = this.meta.publishToSelf === true
    return self ? native().wsPublish(topic, toWire(data)) : native().wsPublish(topic, toWire(data), currentWorker, this.localId)
  }
  publishText(topic: string, data: string, compress?: boolean): number {
    return this.publish(topic, data, compress)
  }
  publishBinary(topic: string, data: BufferSource, compress?: boolean): number {
    return this.publish(topic, data, compress)
  }
  subscribe(topic: string): void {
    if (this.readyState <= 1) native().wsSubscribe(currentWorker, this.localId, topic)
  }
  unsubscribe(topic: string): void {
    if (this.readyState <= 1) native().wsUnsubscribe(currentWorker, this.localId, topic)
  }
  isSubscribed(topic: string): boolean {
    return this.readyState <= 1 && native().wsIsSubscribed(currentWorker, this.localId, topic)
  }
  cork<R>(cb: (ws: this) => R): R {
    return cb(this)
  }
}

// ---- upgrade bookkeeping ----

interface Accept {
  socket: BrustSocket
  headers: [string, string][]
}
const accepted = new WeakMap<Request, Accept>()
const sockets = new Map<number, BrustSocket>()
let nextId = 1
/** A socket whose 101 never completed (Rust failed the handshake after the fetch call) is dropped after this long. */
const PENDING_TTL_MS = 60_000

function sweep(now: number): void {
  for (const [id, s] of sockets) if (s.readyState === 0 && now - s.createdAt > PENDING_TTL_MS) sockets.delete(id)
}
function allocId(): number {
  for (let i = 0; i < 0xffff_ffff; i++) {
    const id = nextId
    nextId = nextId >= 0xffff_ffff ? 1 : nextId + 1
    if (!sockets.has(id)) return id
  }
  throw new Error('brust: no free WebSocket id')
}

/** Elysia's route options → the A2 meta (a subset; Rust clamps them to the `[actions.ws]` maxima). */
export function wsMetaOf(id: number, o: Record<string, unknown> | undefined): WsMeta {
  const m: WsMeta = { id }
  if (!o) return m
  if (typeof o.maxPayloadLength === 'number') m.maxPayload = o.maxPayloadLength
  if (typeof o.idleTimeout === 'number') m.idleTimeout = o.idleTimeout
  if (typeof o.backpressureLimit === 'number') m.backpressureLimit = o.backpressureLimit
  if (typeof o.closeOnBackpressureLimit === 'boolean') m.closeOnBackpressureLimit = o.closeOnBackpressureLimit
  if (typeof o.publishToSelf === 'boolean') m.publishToSelf = o.publishToSelf
  if (typeof o.sendPings === 'boolean') m.sendPings = o.sendPings
  return m
}

/** What `app.server` is for an actions app: just enough of Bun's `Server` for Elysia's `.ws()` route (plan §2d). */
export interface ServerShim {
  upgrade(req: Request, opts?: { headers?: HeadersInit; data?: Record<string, any> }): boolean
  publish(topic: string, data: string | BufferSource, compress?: boolean): number
  requestIP(req: Request): null
}

/** `options`: the app-wide Elysia ws options (`provider.declaredOptions(app)`), read at the first upgrade. Bun has one
 * ws config per server, so Elysia already folds every route's options into it; the shim sends that. */
export function createServerShim(options: () => Record<string, unknown> | undefined): ServerShim {
  let opts: Record<string, unknown> | undefined
  let read = false
  return {
    upgrade(req, o = {}) {
      if (accepted.has(req)) return false
      const now = Date.now()
      sweep(now)
      if (!read) {
        opts = options()
        read = true
      }
      const id = allocId()
      const data = o.data ?? {}
      const socket = new BrustSocket(id, data, wsMetaOf(id, opts), AsyncLocalStorage.snapshot(), now)
      for (const k of ['open', 'message', 'drain', 'close', 'ping', 'pong']) {
        const f = data[k]
        if (typeof f !== 'function') continue
        data[k] = (...a: unknown[]) => {
          const r = f(...a)
          if (r && typeof r.then === 'function') socket.pending = r
          return r
        }
      }
      sockets.set(id, socket)
      accepted.set(req, { socket, headers: [...new Headers(o.headers)] })
      return true
    },
    publish: (topic, data) => native().wsPublish(topic, toWire(data)),
    requestIP: () => null,
  }
}

/** The bridge's side: the accept the route recorded for `req`, as the A2 `ws` meta + upgrade headers, or null. */
export function takeAccept(req: Request): { meta: WsMeta; headers: [string, string][] } | null {
  const a = accepted.get(req)
  if (!a) return null
  accepted.delete(req)
  return { meta: a.socket.meta, headers: a.headers }
}
/** A hook refused (a Response) after `upgrade()` said yes, or the host cannot upgrade: forget the socket. */
export function dropAccept(req: Request): void {
  const a = accepted.get(req)
  if (!a) return
  accepted.delete(req)
  sockets.delete(a.socket.localId)
}
export function dropSocket(id: number): void {
  sockets.delete(id)
}
/** Tests: how many sockets this worker holds. */
export function socketCount(): number {
  return sockets.size
}

// ---- Rust → JS events ----

/** Plan §2d: registers this worker's socket dispatcher. `handler` is Elysia's global ws handler. Events for an unknown
 * socket are dropped (Rust closes it when its `open` is refused). The promise resolves when the handler settles, which
 * is the credit Rust waits on (D6). */
export function startSockets(handler: WsHandler, workerId: number): void {
  currentWorker = workerId
  native().registerSockets(workerId, (localId, ev, data, code, reason) => deliver(handler, localId, ev, data, code, reason))
}

function decode(sock: BrustSocket, d: string | Buffer | null): string | Buffer | ArrayBuffer | Uint8Array {
  if (d === null) return Buffer.alloc(0)
  if (typeof d === 'string' || sock.binaryType === 'nodebuffer') return d
  const u = new Uint8Array(d.byteLength)
  u.set(d)
  return sock.binaryType === 'arraybuffer' ? u.buffer : u
}

/** Exported for tests (a dispatcher without the addon). */
export async function deliver(handler: WsHandler, localId: number, ev: SocketEventName, data: string | Buffer | null, code: number, reason: string): Promise<void> {
  const sock = sockets.get(localId)
  if (!sock) {
    if (ev === 'open') native().wsTerminate(currentWorker, localId)
    return
  }
  // A Close with no Open (the switch to a socket failed after the 101, ws-server N4): the app never saw this socket, so its
  // close handler must not run (Bun never calls close without open). Free the id; a later open for it terminates.
  if (ev === 'close' && sock.readyState === 0) {
    sockets.delete(localId)
    return
  }
  try {
    sock.pending = undefined
    if (ev === 'message') {
      // Elysia queues a message behind a still-running `open` itself, but then the handler's promise is not ours to
      // await: wait for `open` here so the call below is the dispatch.
      const opening = sock.data.opening as Promise<void> | undefined
      if (opening) await opening
      if (sock.readyState > 1) return
    }
    sock.run(() => {
      switch (ev) {
        case 'open':
          sock.readyState = 1
          handler.open?.(sock)
          break
        case 'message':
          handler.message?.(sock, decode(sock, data) as string | Buffer)
          break
        case 'drain':
          handler.drain?.(sock)
          break
        case 'close':
          sock.readyState = 3
          handler.close?.(sock, code, reason)
          break
        case 'ping':
          handler.ping?.(sock, (data ?? Buffer.alloc(0)) as Buffer)
          break
        case 'pong':
          handler.pong?.(sock, (data ?? Buffer.alloc(0)) as Buffer)
          break
      }
    })
    // A handler error is Elysia's to report (it answers on the socket); Rust only needs to know the handler is done.
    await (sock.pending as Promise<unknown> | undefined)?.then(noop, noop)
  } catch (e) {
    console.error(`[brust] websocket ${ev} handler failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  } finally {
    if (ev === 'close') sockets.delete(localId)
  }
}
