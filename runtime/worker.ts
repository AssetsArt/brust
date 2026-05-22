import { renderToString } from "react-dom/server"
import { encodeFrame, Framer, type Frame } from "./framer.ts"
import { SerialQueue } from "./queue.ts"
import { bindRoutes, getPage, createElement } from "./pages.ts"

const WORKER_ID   = process.env.WORKER_ID
const SOCKET_PATH = process.env.SOCKET_PATH

if (!WORKER_ID || !SOCKET_PATH) {
  console.error("[brust worker] WORKER_ID and SOCKET_PATH must be set")
  process.exit(1)
}

const queue = new SerialQueue()

Bun.listen({
  unix: SOCKET_PATH,
  socket: {
    open(_socket) {
      // host connected
    },
    data(socket, chunk) {
      const s = socket as Bun.Socket<unknown>
      let frames: Frame[]
      try {
        const framer: Framer = (s.data as Framer | undefined) ?? (() => {
          const f = new Framer()
          ;(s as unknown as { data: Framer }).data = f
          return f
        })()
        frames = framer.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      } catch (err) {
        console.error(`[brust worker ${WORKER_ID}] framer error:`, err)
        socket.end()
        process.exit(1)
        return
      }
      for (const frame of frames) {
        queue.enqueue(() => handle(s, frame))
      }
    },
    close(_socket) {
      // host disconnected; skeleton: exit so supervisor notices
      process.exit(0)
    },
    error(_socket, error) {
      console.error(`[brust worker ${WORKER_ID}] socket error:`, error)
    },
  },
})

console.log(`[brust worker ${WORKER_ID}] listening at ${SOCKET_PATH}`)

async function handle(socket: Bun.Socket<unknown>, frame: Frame): Promise<void> {
  try {
    switch (frame.type) {
      case "route_registry": {
        bindRoutes(frame.routes)
        socket.write(encodeFrame({ type: "ready" }))
        break
      }
      case "render": {
        const page = getPage(frame.route_id)
        const html = renderToString(
          createElement(page.component, { workerId: WORKER_ID! }),
        )
        socket.write(encodeFrame({ type: "render_ok", html }))
        break
      }
      case "shutdown": {
        socket.end()
        process.exit(0)
      }
      case "ready":
      case "render_ok":
      case "render_err": {
        // These frame types are sent by the worker, never received — treat as protocol error.
        throw new Error(`unexpected inbound frame: ${frame.type}`)
      }
      default: {
        const _exhaustive: never = frame
        throw new Error(`unhandled frame: ${JSON.stringify(_exhaustive)}`)
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      socket.write(encodeFrame({ type: "render_err", message }))
    } catch {
      // best effort
    }
  }
}
