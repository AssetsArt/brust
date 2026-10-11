// The worker side of the `fetch` call kind (design E4/E5, contracts A1/A2). Rust forwards the actions prefix subtree
// here; the app registered with `setActionsApp` (Elysia 2 via brust() — m3f-actions-elysia) answers a web Request
// with a web Response, framed into this worker's SAB slot. No Elysia import: the app is anything with `fetch`.
import type { LoaderReq } from './routes'
import { runInStoreContext } from './store/server-context'

/** A3: the manifest block `brust build` writes (the elysia lane's writer). `entry` is relative to dist. */
export interface ActionsManifest {
  entry: string
  prefix: string
  maxBodyBytes: number
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
  body: { text: string } | { b64: string } | null
  req: LoaderReq
}
/** A2 meta: exactly these two keys (never a store). */
export interface FetchMeta {
  status: number
  headers: [string, string][]
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
export function toRequest(r: FetchRequest): Request {
  const host = r.headers.find(([k]) => k === 'host')?.[1]
  const origin = `http://${host && HOST.test(host) ? host : 'localhost'}`
  const bodyless = r.method === 'GET' || r.method === 'HEAD'
  const body = bodyless || !r.body ? undefined : 'text' in r.body ? enc.encode(r.body.text) : Buffer.from(r.body.b64, 'base64')
  return new Request(origin + r.url, { method: r.method, headers: r.headers, body })
}

/** A2 writer at `slot`'s sub-region `[slot*sub, slot*sub+sub)`, `sub = floor(view.byteLength / slots)`:
 * `[u32 LE meta_len][meta JSON][body]`; returns the byte length. A frame that does not fit becomes R10's 500
 * (always fits a real slot); 0 when not even that fits (Rust: BadResponse → 500). */
export function writeFramed(view: Uint8Array, slot: number, slots: number, status: number, headers: [string, string][], body: Uint8Array): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const dst = view.subarray(slot * sub, slot * sub + sub)
  const meta = enc.encode(JSON.stringify({ status, headers } satisfies FetchMeta))
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

/** The `fetch` call (makeDispatch). Never rejects, never writes JSON: every outcome is a frame. */
export async function runFetch(requestJson: string, view: Uint8Array, slot: number, slots: number): Promise<number> {
  const a = app
  if (!a) return fail(view, slot, slots, 'brust: actions are not configured in this worker')
  try {
    const req = toRequest(JSON.parse(requestJson) as FetchRequest)
    // R1/E5: one store scope around the handler AND the body read (a lazy body may still touch stores).
    const out = await runInStoreContext(async () => {
      const res = await a.fetch(req)
      const pairs: [string, string][] = []
      res.headers.forEach((v, k) => {
        if (k !== 'set-cookie') pairs.push([k, v])
      })
      for (const c of res.headers.getSetCookie()) pairs.push(['set-cookie', c])
      return { status: res.status, pairs, body: new Uint8Array(await res.arrayBuffer()) }
    })
    return writeFramed(view, slot, slots, out.status, out.pairs, out.body)
  } catch (e) {
    console.error(`[brust] action failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return fail(view, slot, slots, 'brust: action failed')
  }
}
