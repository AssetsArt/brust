import { threadId } from 'node:worker_threads'
import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

// F529: the sockets the served tests drive. `threadId` names the worker a socket is pinned to (plan D5).
const app = new Elysia({ adapter: brust() })
  .get('/hello', () => ({ hello: 'world' }))
  // echoes text and binary back
  .ws('/echo', {
    message(ws, message) {
      ws.send(message)
    },
  })
  // a topic: every peer that sent a message is published to the others (publishToSelf is off)
  .ws('/room', {
    open(ws) {
      ws.subscribe('room')
      ws.send(`worker:${threadId}`)
    },
    message(ws, message) {
      ws.publish('room', `peer:${String(message)}`)
    },
  })
  // F532: publish from an HTTP action (ctx.server) and from module scope (app.server, set once the app is mounted)
  .post('/announce', ({ server, query }) => ({ sent: server?.publish('room', `announce:${query.text}`) ?? null }))
  .post('/trigger', () => ({ sent: fanOut('tick') }))
  // a guard: no `x-token`, no upgrade
  .guard({ beforeHandle: ({ headers, status }) => (headers['x-token'] === 'secret' ? undefined : status(401, 'unauthorized')) })
  .ws('/private', {
    open(ws) {
      ws.send('welcome')
    },
    message(ws, message) {
      ws.send(`private:${String(message)}`)
    },
  })

/** What a message-bus subscriber would do: publish into a topic with no socket and no request at hand. */
function fanOut(text: string): number | null {
  return (app as unknown as { server?: { publish(topic: string, data: string): number } }).server?.publish('room', `module:${text}`) ?? null
}

export default app
export type App = typeof app
