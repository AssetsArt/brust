// The worker side of the `fetch` call kind (design E4/E5, contracts A1/A2). Rust forwards the actions prefix subtree
// here; the app registered with `setActionsApp` (Elysia 2 via brust() — m3f-actions-elysia) answers a web Request
// with a web Response, framed into this worker's SAB slot. No Elysia import: the app is anything with `fetch`.
import { putFetchReply, takeFetchBody } from './native'
import type { LoaderReq } from './routes'
import { runInStoreContext } from './store/server-context'

/** A3: the manifest block `brust build` writes (the elysia lane's writer). `entry` is relative to dist. */
export interface ActionsManifest {
  entry: string
  prefix: string
  maxBodyBytes: number
  maxResponseBytes?: number
}
/** What the worker drives: an Elysia 2 app (`app.fetch`, web-standard), or anything with that shape. */
export interface ActionsApp {
  fetch(request: Request): Response | Promise<Response>
}

/** A1 (`protocol.rs` `FetchRequest`): `url` = path + query, prefix included; `headers` as pairs (repeats kept). */
export interface FetchRequest {
  method: string
  url: string
  headers: [string, string][]
  /** `{heap: n}` (F82): more than 262144 bytes, fetched with `takeFetchBody(slot)`. */
  body: { text: string } | { b64: string } | { heap: number } | null
  req: LoaderReq
}
/** A2 meta: `status`, `headers`, and (F82) `heap` — the byte length of a response body that crossed by
 * `putFetchReply` instead of the slot (the slot body is then empty). Never a store. */
export interface FetchMeta {
  status: number
  headers: [string, string][]
  heap?: number
}

/** F82: the worker→Rust heap channel for the in-flight `fetch` call of a slot. The default is the napi addon,
 * loaded lazily (so a fetch that never needs it never touches the binding). */
export interface HeapIo {
  takeBody(slot: number): Uint8Array | null
  putReply(slot: number, body: Uint8Array): boolean
}
const nativeHeapIo: HeapIo = { takeBody: (slot) => takeFetchBody(slot), putReply: (slot, body) => putFetchReply(slot, body) }

let maxResponseBytes = 8_388_608
/** `startWorker` sets the manifest's `actions.maxResponseBytes` (R5). Default 8388608. */
export function setActionsLimits(l: { maxResponseBytes: number }): void {
  maxResponseBytes = l.maxResponseBytes
}

let app: ActionsApp | null = null

/** Registers this worker's actions app. Call once at worker boot, before `registerWorker`. `null` unregisters (tests).
 * Throws TypeError when `app` has no `fetch` function. */
export function setActionsApp(a: ActionsApp | null): void {
  if (a !== null && typeof (a as { fetch?: unknown } | undefined)?.fetch !== 'function')
    throw new TypeError('setActionsApp: the actions app has no fetch(request) function')
  app = a
}
export function getActionsApp(): ActionsApp | null {
  return app
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const HOST = /^[A-Za-z0-9.\-:[\]]+$/
const TEXT_PLAIN: [string, string][] = [['content-type', 'text/plain; charset=utf-8']]

/** A1 → web Request (R8 origin: `http://<host>` when the host pair is sane, else `localhost`). Bytes, never a
 * string body, so no content-type is invented. GET/HEAD never carry a body (R4; `new Request` forbids one). */
export function toRequest(r: FetchRequest, heapBody?: Uint8Array): Request {
  const host = r.headers.find(([k]) => k === 'host')?.[1]
  const origin = `http://${host && HOST.test(host) ? host : 'localhost'}`
  const bodyless = r.method === 'GET' || r.method === 'HEAD'
  const b = r.body
  const body = bodyless || !b ? undefined : 'heap' in b ? (heapBody as BodyInit | undefined) : 'text' in b ? enc.encode(b.text) : Buffer.from(b.b64, 'base64')
  return new Request(origin + r.url, { method: r.method, headers: r.headers, body })
}

/** A2 writer at `slot`'s sub-region `[slot*sub, slot*sub+sub)`, `sub = floor(view.byteLength / slots)`:
 * `[u32 LE meta_len][meta JSON][body]`; returns the byte length. A frame that does not fit becomes R10's 500
 * (always fits a real slot); 0 when not even that fits (Rust: BadResponse → 500). */
export function writeFramed(view: Uint8Array, slot: number, slots: number, status: number, headers: [string, string][], body: Uint8Array, heap?: number): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const dst = view.subarray(slot * sub, slot * sub + sub)
  const meta = enc.encode(JSON.stringify((heap === undefined ? { status, headers } : { status, headers, heap }) satisfies FetchMeta))
  const total = 4 + meta.length + body.length
  if (total <= sub) return put(dst, meta, body)
  console.error(`[brust] action response ${total} bytes exceeds the ${sub}-byte slot (F82) — answered 500`)
  const m = enc.encode(JSON.stringify({ status: 500, headers: TEXT_PLAIN } satisfies FetchMeta))
  const b = enc.encode(`brust: action response exceeds ${sub} bytes`)
  return 4 + m.length + b.length > sub ? 0 : put(dst, m, b)
}

function put(dst: Uint8Array, meta: Uint8Array, body: Uint8Array): number {
  new DataView(dst.buffer, dst.byteOffset, 4).setUint32(0, meta.length, true)
  dst.set(meta, 4)
  dst.set(body, 4 + meta.length)
  return 4 + meta.length + body.length
}

/** The A2 reader (tests; mirrors Rust `decode_fetch_frame`). Throws on a malformed frame. */
export function readFramed(view: Uint8Array, slot: number, slots: number, len: number): { meta: FetchMeta; body: Uint8Array } {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  if (len < 4 || len > sub) throw new Error(`bad frame length ${len} (slot ${sub})`)
  const src = view.subarray(slot * sub, slot * sub + len)
  const metaLen = new DataView(src.buffer, src.byteOffset, 4).getUint32(0, true)
  if (4 + metaLen > len) throw new Error(`bad frame: meta_len ${metaLen} > ${len - 4}`)
  const meta = JSON.parse(dec.decode(src.subarray(4, 4 + metaLen))) as FetchMeta
  return { meta, body: src.slice(4 + metaLen) }
}

const fail = (view: Uint8Array, slot: number, slots: number, msg: string) => writeFramed(view, slot, slots, 500, TEXT_PLAIN, enc.encode(msg))

/** The store-scoped core shared by `runFetch` and `fetchInScope`: R1/E5 — one store scope around the handler AND the
 * body read (a lazy body may still touch stores); set-cookie values kept apart. */
export async function fetchParts(a: ActionsApp, req: Request): Promise<{ status: number; pairs: [string, string][]; body: Uint8Array }> {
  return runInStoreContext(async () => {
    const res = await a.fetch(req)
    const pairs: [string, string][] = []
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') pairs.push([k, v])
    })
    for (const c of res.headers.getSetCookie()) pairs.push(['set-cookie', c])
    return { status: res.status, pairs, body: new Uint8Array(await res.arrayBuffer()) }
  })
}

/** Host-agnostic entry (Cloudflare `action(req)`): the same scope and framing-free parts as `runFetch`, as a Response. */
export async function fetchInScope(a: ActionsApp, req: Request): Promise<Response> {
  const { status, pairs, body } = await fetchParts(a, req)
  const headers = new Headers()
  for (const [k, v] of pairs) headers.append(k, v)
  return new Response([101, 204, 205, 304].includes(status) ? null : (body as BodyInit), { status, headers })
}

/** The `action` export of a worker whose app has no `[actions]`. */
export const noActions = async (_: Request): Promise<Response> =>
  new Response('brust: actions are not configured in this worker', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })

/** The `fetch` call (makeDispatch). Never rejects, never writes JSON: every outcome is a frame. A body of
 * more than 262144 bytes arrives by `io.takeBody` (A1 `{heap}`); a response that does not fit the slot leaves
 * by `io.putReply` with only status/headers/`heap` in the slot (F82), unless it exceeds `max_response_bytes`. */
export async function runFetch(requestJson: string, view: Uint8Array, slot: number, slots: number, io: HeapIo = nativeHeapIo): Promise<number> {
  const a = app
  if (!a) return fail(view, slot, slots, 'brust: actions are not configured in this worker')
  try {
    const fr = JSON.parse(requestJson) as FetchRequest
    let heapBody: Uint8Array | undefined
    if (fr.body && 'heap' in fr.body) {
      const got = io.takeBody(slot)
      if (!got || got.length !== fr.body.heap) throw new Error(`heap request body ${got ? `${got.length} != ${fr.body.heap}` : 'missing'} bytes (F82)`)
      heapBody = got
    }
    const req = toRequest(fr, heapBody)
    // R1/E5: one store scope around the handler AND the body read (a lazy body may still touch stores).
    const out = await fetchParts(a, req)
    const sub = Math.floor(view.byteLength / Math.max(1, slots))
    const metaLen = (m: FetchMeta) => enc.encode(JSON.stringify(m)).length
    if (4 + metaLen({ status: out.status, headers: out.pairs }) + out.body.length <= sub) return writeFramed(view, slot, slots, out.status, out.pairs, out.body)
    if (out.body.length > maxResponseBytes) {
      console.error(`[brust] action response body ${out.body.length} bytes exceeds max_response_bytes ${maxResponseBytes} — answered 500`)
      return writeFramed(view, slot, slots, 500, TEXT_PLAIN, enc.encode(`brust: action response exceeds ${maxResponseBytes} bytes`))
    }
    // The meta alone must fit; otherwise writeFramed's own 500 (R10) answers.
    if (4 + metaLen({ status: out.status, headers: out.pairs, heap: out.body.length }) > sub) return writeFramed(view, slot, slots, out.status, out.pairs, out.body)
    if (!io.putReply(slot, out.body)) throw new Error('heap reply declined by the server (F82)')
    return writeFramed(view, slot, slots, out.status, out.pairs, new Uint8Array(0), out.body.length)
  } catch (e) {
    console.error(`[brust] action failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return fail(view, slot, slots, 'brust: action failed')
  }
}
