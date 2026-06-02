import type { WsHandlers } from '../../../runtime/routes.ts'

/** Instrumented WS echo handler used by integration tests. Records the
 * last close code/reason into globalThis.__lastWsClose so the lastWsClose
 * probe action can observe it. This is the instrumented variant; real apps
 * write a plain handler without the globalThis bookkeeping. */
export default {
  message(socket, data) {
    void socket.send(data)
  },
  close(_socket, code, reason) {
    ;(globalThis as { __lastWsClose?: { code: number, reason: string } }).__lastWsClose = { code, reason }
  },
} satisfies WsHandlers
