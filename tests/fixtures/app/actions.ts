import { defineActions } from '../../../runtime/index.ts'
import { z } from 'zod'
import type { Middleware } from '../../../runtime/routes.ts'

const requireUser: Middleware = async (req, next) =>
  req.cookies['user'] ? next() : { status: 401, body: 'login required' }

export const actions = defineActions()
  .post('/notes', ({ body }) => ({ id: 'n-' + body.text.length }), {
    body: z.object({ text: z.string().max(1000) }),
  })
  .get('/whoami', ({ req }) => ({ user: req.cookies['user'] ?? null }))
  .delete('/notes/{id}', ({ params }) => ({ ok: true as const, id: params.id }), {
    middleware: [requireUser],
  })
  // Out-of-band probes for the SSE/WS integration tests. They read a value the
  // SSE/WS handler recorded into globalThis. With BRUST_WORKERS=1 the probe
  // request lands on the same JS context that ran the handler, so the global
  // is visible. (These are GET endpoints — no body, just observe state.)
  .get('/last-sse-abort', () => ({
    ts: (globalThis as { __lastSseAbort?: number }).__lastSseAbort ?? 0,
  }))
  .get('/last-ws-close', () =>
    (globalThis as { __lastWsClose?: { code: number; reason: string } }).__lastWsClose ?? {
      code: 0,
      reason: '',
    })

export type Actions = typeof actions
