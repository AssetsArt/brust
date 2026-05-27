import type { Route, WsHandlers, WsSocket } from '../routes.ts'

/** Server-to-client protocol. Client never sends after open. */
export type DevMessage =
  | { type: 'building' }
  | { type: 'reload' }
  | { type: 'css-update'; href: string }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'ok' }

const clients: Set<WsSocket> = new Set()

export function _clientCountForTests(): number { return clients.size }
export function _resetForTests(): void { clients.clear() }

/** Build a synthetic Route at /_brust/dev that brust.run() prepends to
 * the user's routes array when dev mode is on. */
export function createDevWsRoute(): Route {
  return {
    path: '/_brust/dev',
    websocket: () => Promise.resolve(devHandlers),
  }
}

const devHandlers: WsHandlers = {
  open(socket) { clients.add(socket) },
  close(socket) { clients.delete(socket) },
  message() { /* ignore — server→client only */ },
}

/** Send the message to every connected dev client. Per-socket errors are
 * caught and the offending socket is dropped — one bad client cannot
 * stall the broadcast. */
export async function broadcast(msg: DevMessage): Promise<void> {
  const json = JSON.stringify(msg)
  const sends: Promise<unknown>[] = []
  for (const s of clients) {
    sends.push(s.send(json).catch(() => { clients.delete(s) }))
  }
  await Promise.all(sends)
}
