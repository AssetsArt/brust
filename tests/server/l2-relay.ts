// The cache-adapter lane A native e2e relay (R12): ONE memoryAdapter({ broadcast: 'push' }) shared by
// every `brust start` process of the test over HTTP + a WebSocket. Prints `listening <port>`.
import { memoryAdapter } from '../../packages/brust/src/cache-adapter'

const a = memoryAdapter({ broadcast: 'push' })
let gets = 0
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/sub') return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
    if (url.pathname === '/stats') return Response.json({ publishCount: a.__test.publishCount(), gets })
    if (req.method !== 'POST') return new Response('not found', { status: 404 })
    const body = (await req.json().catch(() => ({}))) as Record<string, any>
    switch (url.pathname) {
      case '/get': {
        gets++
        const r = await a.store.get(body.key)
        return Response.json({ page: r.page ? { status: r.page.status, headers: r.page.headers, body: b64(r.page.body) } : null, stamp: r.stamp, entryStamp: r.entryStamp, storedAt: r.storedAt })
      }
      case '/set':
        return Response.json({ ok: await a.store.set(body.key, { status: body.page.status, headers: body.page.headers, body: new Uint8Array(Buffer.from(body.page.body, 'base64')) }, body.meta) })
      case '/invalidate':
        await a.store.invalidate(body.args)
        return Response.json({})
      case '/publish':
        return Response.json({ seq: await a.broadcast!.publish(body.args, body.origin) })
      case '/hang-next-get':
        a.__test.hangNextGet(3000)
        return Response.json({})
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    async open(ws) {
      const stop = await a.broadcast!.subscribe!(
        (e) => ws.send(JSON.stringify(e)),
        () => ws.send(JSON.stringify({ gap: true })),
      )
      ;(ws as unknown as { stop: () => Promise<void> }).stop = stop
    },
    message() {},
    close(ws) {
      void (ws as unknown as { stop?: () => Promise<void> }).stop?.()
    },
  },
})
console.log(`listening ${server.port}`)
