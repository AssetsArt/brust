import { describe, test, expect, mock } from 'bun:test'
import {
  createDevWsRoute,
  broadcast,
  installWorkerBroadcastListener,
  _clientCountForTests,
  _resetForTests,
} from './ws-channel.ts'

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

  test('message handler is a no-op', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const sock: any = { id: 1n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(sock, { req: {} as any, subprotocol: null })
    handlers.message?.(sock, 'anything')
    expect(sock.send).not.toHaveBeenCalled()
  })

  test('broadcast delegates the serialized message to the native dev channel', async () => {
    // The dev WS is a Rust-owned control channel: broadcast() hands the JSON to
    // the napi addon, which pushes it through each /_brust/dev connection's
    // Rust-owned send_tx (surviving worker restarts). See server.rs.
    const calls: string[] = []
    mock.module('../index.js', () => ({
      napiDevBroadcast: (json: string) => calls.push(json),
    }))
    await broadcast({ type: 'reload' })
    expect(calls).toEqual(['{"type":"reload"}'])
    await broadcast({ type: 'css-update', href: '/x.css' })
    expect(calls[1]).toBe('{"type":"css-update","href":"/x.css"}')
  })

  test('broadcast is a no-op when the native dev channel is unavailable', async () => {
    // Optional chaining guards the call so a build without napiDevBroadcast (or
    // a non-dev addon) does not throw at the coordinator's broadcast points.
    mock.module('../index.js', () => ({}))
    await broadcast({ type: 'ok' })
  })

  test('installWorkerBroadcastListener routes dev-broadcast to local clients', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    let sent: any
    const sock: any = {
      id: 1n,
      send: (m: any) => {
        sent = m
        return Promise.resolve()
      },
      close: () => {},
    }
    handlers.open?.(sock, { req: {} as any, subprotocol: null })

    installWorkerBroadcastListener()
    const json = JSON.stringify({ type: 'reload' })
    ;(globalThis as any).dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dev-broadcast', json },
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toBe(json)
  })
})
