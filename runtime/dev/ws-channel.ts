import type { Route, WsHandlers, WsSocket } from '../routes.ts'

/** Server-to-client protocol. Client never sends after open. */
export type DevMessage =
  | { type: 'building' }
  | { type: 'reload' }
  | { type: 'css-update'; href: string }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'ok' }

// Worker-side state. WS connections to /_brust/dev are dispatched by Rust
// to a worker isolate, so this Set lives in that worker's module copy.
// Each worker has its own independent set; only the worker holding a
// given connection has it in `clients`.
const clients: Set<WsSocket> = new Set()

export function _clientCountForTests(): number {
  return clients.size
}
export function _resetForTests(): void {
  clients.clear()
}

/** Build the synthetic /_brust/dev WS route. brust.run() prepends this
 * to opts.routes in dev mode (both main + worker route arrays). */
export function createDevWsRoute(): Route {
  return {
    path: '/_brust/dev',
    websocket: () => Promise.resolve(devHandlers),
  }
}

const devHandlers: WsHandlers = {
  open(socket) {
    clients.add(socket)
  },
  close(socket) {
    clients.delete(socket)
  },
  message() {
    /* ignore — server→client only */
  },
}

/** Worker-side: forward JSON to every client connected to this worker. */
async function broadcastLocal(json: string): Promise<void> {
  const sends: Promise<unknown>[] = []
  for (const s of clients) {
    sends.push(
      s.send(json).catch(() => {
        clients.delete(s)
      }),
    )
  }
  await Promise.all(sends)
}

let workerListenerInstalled = false

/** Worker-side: install a message listener that receives `dev-broadcast`
 * envelopes from the main process and forwards them to this worker's
 * local clients. Idempotent. After install, posts `brust-worker-ready`
 * back to the parent so spawnAll() knows the worker is ready to relay
 * broadcasts (avoids a race where `reload` is dispatched before the
 * fresh worker's listener is wired). */
export function installWorkerBroadcastListener(): void {
  if (workerListenerInstalled) return
  workerListenerInstalled = true
  ;(globalThis as any).addEventListener('message', (e: MessageEvent) => {
    const data: any = (e as any).data
    if (data && data.type === 'dev-broadcast' && typeof data.json === 'string') {
      void broadcastLocal(data.json)
    }
  })
  // Signal readiness to parent (main thread). In a Worker context,
  // postMessage targets the parent.
  try {
    ;(globalThis as any).postMessage({ type: 'brust-worker-ready' })
  } catch {
    /* not in a worker (unit test); harmless */
  }
}

/** Main-side: push the message to every `/_brust/dev` client through the napi
 * addon. The dev WS is a Rust-owned control channel (see the `/_brust/dev`
 * branch in crates/brust/src/server.rs), so the frame is delivered straight
 * through each connection's Rust-owned send_tx and SURVIVES a hot reload's
 * worker restart.
 *
 * The previous implementation relayed main→worker→worker-local-clients, which
 * lost the `reload` frame: the coordinator broadcasts it AFTER terminateAll(),
 * by which point the connection's worker-side registration had died with the
 * old worker. */
export async function broadcast(msg: DevMessage): Promise<void> {
  const json = JSON.stringify(msg)
  const native = await import('../index.js')
  ;(native as { napiDevBroadcast?: (json: string) => void }).napiDevBroadcast?.(json)
}
