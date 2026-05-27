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

  test('broadcast postMessages json to every registered worker', async () => {
    _resetForTests()
    const reg = await import('./worker-registry.ts')
    reg._resetForTests()
    const posts: any[] = []
    const w1: any = { postMessage: (m: any) => posts.push({ to: 'w1', m }) }
    const w2: any = { postMessage: (m: any) => posts.push({ to: 'w2', m }) }
    reg.registerInitialPool([w1, w2], '/dummy', 2, {})
    await broadcast({ type: 'reload' })
    expect(posts.length).toBe(2)
    expect(posts[0].m).toEqual({ type: 'dev-broadcast', json: '{"type":"reload"}' })
    expect(posts[1].m).toEqual({ type: 'dev-broadcast', json: '{"type":"reload"}' })
    reg._resetForTests()
  })

  test('broadcast tolerates worker postMessage throwing', async () => {
    _resetForTests()
    const reg = await import('./worker-registry.ts')
    reg._resetForTests()
    const good: any = { postMessage: () => {} }
    const bad: any = { postMessage: () => { throw new Error('terminated') } }
    reg.registerInitialPool([bad, good], '/dummy', 2, {})
    await broadcast({ type: 'ok' })
    reg._resetForTests()
  })

  test('installWorkerBroadcastListener routes dev-broadcast to local clients', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    let sent: any
    const sock: any = {
      id: 1n,
      send: (m: any) => { sent = m; return Promise.resolve() },
      close: () => {},
    }
    handlers.open?.(sock, { req: {} as any, subprotocol: null })

    installWorkerBroadcastListener()
    const json = JSON.stringify({ type: 'reload' })
    ;(globalThis as any).dispatchEvent(new MessageEvent('message', {
      data: { type: 'dev-broadcast', json },
    }))
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toBe(json)
  })
})
