import type { WsHandlers } from '../../runtime/routes.ts'

/** Demo WS handler: echoes every incoming frame back unchanged. Connect
 * with any WebSocket client to `ws://HOST:PORT/ws/echo` and any message
 * you send comes straight back. */
export default {
  message(socket, data) {
    void socket.send(data)
  },
} satisfies WsHandlers
