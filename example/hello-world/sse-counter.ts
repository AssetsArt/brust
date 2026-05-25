import type { BrustRequest } from '../../runtime/routes.ts'

/** Demo SSE handler: emits 3 `data: N\n\n` frames at 50 ms intervals
 * then closes. Records the abort timestamp into a module-global so the
 * lastSseAbort action probe can observe it in integration tests. */
export function counterStream(req: BrustRequest): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      let n = 0
      const id = setInterval(() => {
        controller.enqueue(`data: ${++n}\n\n`)
        if (n >= 3) {
          clearInterval(id)
          controller.close()
        }
      }, 50)
      req.signal.addEventListener('abort', () => {
        clearInterval(id)
        ;(globalThis as { __lastSseAbort?: number }).__lastSseAbort = Date.now()
      })
    },
  })
}

/** Demo SSE handler: never enqueues a data frame. Used to assert the
 * framework's heartbeat (`: ping\n\n`) — the only bytes seen by the
 * client are framework-emitted heartbeats. */
export function idleStream(req: BrustRequest): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      req.signal.addEventListener('abort', () => controller.close())
    },
  })
}
