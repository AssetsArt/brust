import { test, expect, mock } from 'bun:test'
import { handleWsConn, pickSubprotocol, type WsCall } from './handler.ts'
import type { Route, BrustRequest, WsHandlers } from '../routes.ts'

function makeNapi() {
  const sends: Array<{ conn_id: bigint; data: Uint8Array; isBinary: boolean }> = []
  let onMessage: ((data: Uint8Array, isBinary: boolean) => void) | undefined
  let onClose: ((code: number, reason: string) => void) | undefined
  return {
    sends,
    napi: {
      async send(conn_id: bigint, data: Uint8Array, isBinary: boolean) {
        sends.push({ conn_id, data, isBinary })
      },
      close: mock((_conn_id: bigint, _code: number, _reason: string) => {}),
      signalOpen: mock(() => {}),
      registerHandlers: (
        _conn_id: bigint,
        onMsg: (data: Uint8Array, isBinary: boolean) => void,
        onCls: (code: number, reason: string) => void,
      ) => {
        onMessage = onMsg
        onClose = onCls
      },
    },
    fireMessage: (data: Uint8Array, isBinary: boolean) => onMessage?.(data, isBinary),
    fireClose: (code: number, reason: string) => onClose?.(code, reason),
  }
}

function makeReq(): BrustRequest {
  return {
    method: 'GET',
    url: '/ws/echo',
    headers: {},
    cookies: {},
    search: {},
    signal: undefined as unknown as AbortSignal,
  } as BrustRequest
}

test('pickSubprotocol: first match in route order wins', () => {
  expect(pickSubprotocol(['chat.v0', 'chat.v1'], ['chat.v2', 'chat.v1'])).toBe('chat.v1')
})

test('pickSubprotocol: no overlap returns null', () => {
  expect(pickSubprotocol(['chat.v0'], ['chat.v1', 'chat.v2'])).toBe(null)
})

test('pickSubprotocol: route declares none → null (no negotiation)', () => {
  expect(pickSubprotocol(['chat.v0'], [])).toBe(null)
  expect(pickSubprotocol(['chat.v0'], undefined)).toBe(null)
})

test('handler: signalOpen 101 + open(socket, ctx) fires + send proxies napi', async () => {
  const fx = makeNapi()
  let opened: { socket: any; ctx: any } | undefined
  const handlers: WsHandlers = {
    open(socket, ctx) {
      opened = { socket, ctx }
      void socket.send('hi')
    },
  }
  const call: WsCall = { kind: 'ws', conn_id: 1n, client_subprotocols: [], req: makeReq() }
  const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
  await handleWsConn(call, route, fx.napi)
  expect(fx.napi.signalOpen).toHaveBeenCalledTimes(1)
  await new Promise((r) => setTimeout(r, 10))
  expect(opened).toBeDefined()
  expect(fx.sends[0]?.isBinary).toBe(false)
  expect(new TextDecoder().decode(fx.sends[0]!.data)).toBe('hi')
  fx.fireClose(1000, 'normal')
})

test('handler: on_message arrives as string for text, Uint8Array for binary', async () => {
  const fx = makeNapi()
  const received: Array<string | Uint8Array> = []
  const handlers: WsHandlers = {
    message(_s, data) {
      received.push(data)
    },
  }
  const call: WsCall = { kind: 'ws', conn_id: 2n, client_subprotocols: [], req: makeReq() }
  const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
  await handleWsConn(call, route, fx.napi)
  fx.fireMessage(new TextEncoder().encode('hello'), false)
  fx.fireMessage(new Uint8Array([1, 2, 3]), true)
  await new Promise((r) => setTimeout(r, 10))
  expect(received[0]).toBe('hello')
  expect(received[1]).toBeInstanceOf(Uint8Array)
  expect((received[1] as Uint8Array)[0]).toBe(1)
  fx.fireClose(1000, '')
})

test('handler: socket.close enqueues napi.close + subsequent send rejects', async () => {
  const fx = makeNapi()
  let s: any
  const handlers: WsHandlers = {
    open(socket) {
      s = socket
    },
  }
  const call: WsCall = { kind: 'ws', conn_id: 3n, client_subprotocols: [], req: makeReq() }
  const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
  await handleWsConn(call, route, fx.napi)
  await new Promise((r) => setTimeout(r, 10))
  s.close(4000, 'bye')
  expect(fx.napi.close).toHaveBeenCalledTimes(1)
  await expect(s.send('after close')).rejects.toThrow(/already closed/)
})

test('handler: message-handler throw is logged but conn stays open', async () => {
  const fx = makeNapi()
  const errs: any[] = []
  const origError = console.error
  console.error = (...a: any[]) => {
    errs.push(a)
  }
  try {
    const handlers: WsHandlers = {
      message() {
        throw new Error('boom')
      },
    }
    const call: WsCall = { kind: 'ws', conn_id: 4n, client_subprotocols: [], req: makeReq() }
    const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
    await handleWsConn(call, route, fx.napi)
    fx.fireMessage(new TextEncoder().encode('bad'), false)
    await new Promise((r) => setTimeout(r, 20))
    expect(errs.length).toBeGreaterThan(0)
    expect(fx.napi.close).not.toHaveBeenCalled()
  } finally {
    console.error = origError
  }
  fx.fireClose(1000, '')
})
