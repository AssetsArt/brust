import type { Route, BrustRequest, RouteCall } from '../routes.ts'

export type SseCall = Extract<RouteCall, { kind: 'sse' }>

/** NAPI surface — Rust provides these. In tests, a mock satisfies the shape. */
export interface SseNapi {
  write(conn_id: bigint, bytes: Uint8Array): Promise<void>
  close(conn_id: bigint): void
  registerAbort(conn_id: bigint, cb: () => void): void
  signalOpen(conn_id: bigint, status: number, body: string, contentType: string): void
}

const encoder = new TextEncoder()
const PING_FRAME = encoder.encode(': ping\n\n')

/**
 * Per-connection JS driver for SSE routes. Called once per client connection.
 *
 * Contract with the Rust napi shim:
 *   - napi.registerAbort(conn_id, cb)  — Rust calls cb when client disconnects
 *   - napi.signalOpen(conn_id, status, body, contentType)
 *                                      — JS reports verdict; Rust waits before writing headers
 *   - napi.write(conn_id, bytes)       — write a chunk; Promise resolves when TCP write completes (backpressure)
 *   - napi.close(conn_id)             — JS tells Rust to tear down the per-conn task
 */
export async function handleSseStream(
  call: SseCall,
  route: Route,
  napi: SseNapi,
): Promise<void> {
  // 1. Create per-conn AbortController + a fresh request object whose signal
  //    points at it. We spread call.req rather than mutating in place so the
  //    underlying envelope object (potentially reused by makeRenderer in the
  //    future) is never modified — the SSE-specific signal lives on a copy.
  const controller = new AbortController()
  const req: BrustRequest = { ...call.req, signal: controller.signal }

  // 2. Wire Rust→JS abort.
  napi.registerAbort(call.conn_id, () => controller.abort())

  // 3. Open the user's stream. Throw → signal 500 and close.
  let stream: ReadableStream<Uint8Array | string>
  try {
    stream = await route.sse!(req)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    napi.signalOpen(call.conn_id, 500, `sse handler threw: ${msg}`, 'text/plain; charset=utf-8')
    napi.close(call.conn_id)
    return
  }

  // 4. Signal open OK — Rust writes SSE response headers.
  napi.signalOpen(call.conn_id, 200, '', 'text/event-stream')

  // 5. Heartbeat + reader loop.
  const reader = stream.getReader()
  const heartbeatMs = route.sseOptions?.heartbeatMs ?? 15_000
  const heartbeatId = heartbeatMs > 0
    ? setInterval(() => { void napi.write(call.conn_id, PING_FRAME) }, heartbeatMs)
    : null

  // Force-cancel reader on abort so a stuck `await reader.read()` unwinds
  // even if the author didn't listen to req.signal.
  controller.signal.addEventListener('abort', () => { void reader.cancel() })

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const bytes = typeof value === 'string' ? encoder.encode(value) : value
      await napi.write(call.conn_id, bytes)
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(`[brust] sse stream error conn=${call.conn_id}:`, err)
    }
  } finally {
    if (heartbeatId !== null) clearInterval(heartbeatId)
    napi.close(call.conn_id)
    try { reader.releaseLock() } catch {}
  }
}
