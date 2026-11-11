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

export default app
export type App = typeof app
