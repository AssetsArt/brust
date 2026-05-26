import type { BrustRequest } from '../../runtime/routes.ts'

/** Demo SSE handler: emits 3 `data: N\n\n` frames at 50 ms intervals then
 * closes. Plain and self-contained — pair it with a browser EventSource at
 * `/sse-counter` to see the events arrive live. */
export function counterStream(_req: BrustRequest): ReadableStream<string> {
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
    },
  })
}
