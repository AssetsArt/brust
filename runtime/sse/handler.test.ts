import { test, expect, mock } from 'bun:test'
import { handleSseStream, type SseCall } from './handler.ts'
import type { Route, BrustRequest } from '../routes.ts'

function makeNapi() {
  const writes: Array<{ conn_id: bigint, bytes: Uint8Array }> = []
  let aborted: (() => void) | null = null
  return {
    writes,
    napi: {
      async write(conn_id: bigint, bytes: Uint8Array) { writes.push({ conn_id, bytes }) },
      close: mock(() => {}),
      registerAbort: (_conn_id: bigint, cb: () => void) => { aborted = cb },
      signalOpen: mock(() => {}),
    },
    fireAbort: () => { aborted?.() },
  }
}

function makeReq(): BrustRequest {
  // Minimal BrustRequest stub — only fields the glue touches.
  return {
    method: 'GET', url: '/sse-counter', headers: {}, cookies: {}, search: {},
    signal: undefined as unknown as AbortSignal,   // glue overwrites
  } as BrustRequest
}

test('handler: chunks forwarded as bytes; string chunks utf-8 encoded', async () => {
  const { napi, writes } = makeNapi()
  const route: Route = {
    path: '/x',
    sse: () => new ReadableStream({
      start(c) { c.enqueue('data: hi\n\n'); c.enqueue(new Uint8Array([42])); c.close() },
    }),
  } as Route
  const call: SseCall = { kind: 'sse', conn_id: 1n, req: makeReq() }
  await handleSseStream(call, route, napi)
  expect(writes.length).toBeGreaterThanOrEqual(2)
  const first = new TextDecoder().decode(writes[0].bytes)
  expect(first).toBe('data: hi\n\n')
  expect(writes[1].bytes[0]).toBe(42)
})

test('handler: heartbeat fires after heartbeatMs', async () => {
  const { napi, writes } = makeNapi()
  let closeStreamLater: (() => void) | undefined
  const route: Route = {
    path: '/x',
    sseOptions: { heartbeatMs: 50 },
    sse: () => new ReadableStream({
      start(c) { closeStreamLater = () => c.close() },
    }),
  } as Route
  const call: SseCall = { kind: 'sse', conn_id: 2n, req: makeReq() }
  const p = handleSseStream(call, route, napi)
  await new Promise(r => setTimeout(r, 200))      // wait for 2-3 ticks
  closeStreamLater?.()
  await p
  const pings = writes.filter(w => new TextDecoder().decode(w.bytes) === ': ping\n\n')
  expect(pings.length).toBeGreaterThanOrEqual(1)
})

test('handler: abort cancels reader + clears interval + closes', async () => {
  const fx = makeNapi()
  let opened = false
  // Capture the per-conn req that handleSseStream passes into route.sse —
  // since the handler spreads call.req into a new object, the AbortController's
  // signal lives on that copy, not on the outer call.req.
  let observedReq: BrustRequest | undefined
  const route: Route = {
    path: '/x',
    sseOptions: { heartbeatMs: 1000 },
    sse: (r) => {
      observedReq = r
      return new ReadableStream({
        async pull(c) {
          if (opened) return
          opened = true
          // never enqueue — simulates idle stream
          await new Promise(() => {})  // pending forever
        },
      })
    },
  } as Route
  const call: SseCall = { kind: 'sse', conn_id: 3n, req: makeReq() }
  const p = handleSseStream(call, route, fx.napi)
  await new Promise(r => setTimeout(r, 30))
  fx.fireAbort()
  await p
  expect(fx.napi.close).toHaveBeenCalledTimes(1)
  // The req passed into route.sse should have its signal aborted now.
  expect(observedReq?.signal.aborted).toBe(true)
})

test('handler: handler-thrown error closes the conn without crashing', async () => {
  const { napi } = makeNapi()
  const route: Route = {
    path: '/x',
    sse: () => { throw new Error('boom') },
  } as unknown as Route
  const call: SseCall = { kind: 'sse', conn_id: 4n, req: makeReq() }
  await handleSseStream(call, route, napi)
  expect(napi.close).toHaveBeenCalledTimes(1)
})

test('handler: heartbeatMs=0 disables the interval', async () => {
  const fx = makeNapi()
  let close: (() => void) | undefined
  const route: Route = {
    path: '/x',
    sseOptions: { heartbeatMs: 0 },
    sse: () => new ReadableStream({
      start(c) { close = () => c.close() },
    }),
  } as Route
  const call: SseCall = { kind: 'sse', conn_id: 5n, req: makeReq() }
  const p = handleSseStream(call, route, fx.napi)
  await new Promise(r => setTimeout(r, 100))
  close?.()
  await p
  const pings = fx.writes.filter(w => new TextDecoder().decode(w.bytes) === ': ping\n\n')
  expect(pings.length).toBe(0)
})
