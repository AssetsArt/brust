import type { WsHandlers } from '../../../runtime/routes.ts'

/** Demo WS handler that closes immediately on open with a custom code.
 * Used by integration test 3 to verify server-initiated close
 * propagates to the client's onclose event. */
export default {
  open(socket) {
    socket.close(4000, 'bye')
  },
} satisfies WsHandlers
