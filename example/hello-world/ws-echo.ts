import type { WsHandlers } from '../../runtime/routes.ts'

/** Demo WS handler: echoes every incoming frame back unchanged.
 * Records the last close code/reason into globalThis.__lastWsClose
 * so the lastWsClose probe action can observe it. Used by integration
 * tests 1, 2, 4, 5, 6, 7. */
export default {
  message(socket, data) {
    void socket.send(data)
  },
  close(_socket, code, reason) {
    ;(globalThis as { __lastWsClose?: { code: number, reason: string } }).__lastWsClose = { code, reason }
  },
} satisfies WsHandlers
