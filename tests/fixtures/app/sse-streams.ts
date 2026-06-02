import type { BrustRequest } from '../../../runtime/routes.ts'

/** Instrumented counter stream used by integration tests. Emits 3 frames
 * at 50ms intervals then closes. Records abort timestamp into globalThis
 * so the lastSseAbort probe action can observe it. This is the instrumented
 * variant; real apps write a plain stream without the globalThis bookkeeping. */
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

/** SSE handler that never enqueues a data frame. Used to assert the
 * framework's heartbeat (`: ping\n\n`) — the only bytes seen by the
 * client are framework-emitted heartbeats. */
export function idleStream(req: BrustRequest): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      req.signal.addEventListener('abort', () => controller.close())
    },
  })
}
