import { describe, test, expect, mock } from 'bun:test'
import { createDevWsRoute, broadcast, _clientCountForTests, _resetForTests } from './ws-channel.ts'

describe('runtime/dev/ws-channel', () => {
  test('createDevWsRoute returns a route with path /_brust/dev', () => {
    const r = createDevWsRoute()
    expect(r.path).toBe('/_brust/dev')
    expect(typeof r.websocket).toBe('function')
  })

  test('open adds socket to client set; close removes it', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const sock: any = { id: 1n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(sock, { req: {} as any, subprotocol: null })
    expect(_clientCountForTests()).toBe(1)
    handlers.close?.(sock, 1000, '')
    expect(_clientCountForTests()).toBe(0)
  })

  test('broadcast sends JSON to every connected client', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const sock1: any = { id: 1n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    const sock2: any = { id: 2n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(sock1, { req: {} as any, subprotocol: null })
    handlers.open?.(sock2, { req: {} as any, subprotocol: null })
    await broadcast({ type: 'reload' })
    expect(sock1.send).toHaveBeenCalledWith('{"type":"reload"}')
    expect(sock2.send).toHaveBeenCalledWith('{"type":"reload"}')
  })

  test('broadcast tolerates per-socket send errors', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const bad: any = { id: 1n, send: mock(() => Promise.reject(new Error('boom'))), close: mock(() => {}) }
    const good: any = { id: 2n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(bad, { req: {} as any, subprotocol: null })
    handlers.open?.(good, { req: {} as any, subprotocol: null })
    await broadcast({ type: 'ok' })
    expect(good.send).toHaveBeenCalledWith('{"type":"ok"}')
  })

  test('message handler ignores all incoming messages (server→client only protocol)', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const sock: any = { id: 1n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(sock, { req: {} as any, subprotocol: null })
    handlers.message?.(sock, 'anything')
    expect(sock.send).not.toHaveBeenCalled()
  })
})
