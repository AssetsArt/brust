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

export function _clientCountForTests(): number { return clients.size }
export function _resetForTests(): void { clients.clear() }

/** Build the synthetic /_brust/dev WS route. brust.run() prepends this
 * to opts.routes in dev mode (both main + worker route arrays). */
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

/** Worker-side: forward JSON to every client connected to this worker. */
async function broadcastLocal(json: string): Promise<void> {
  const sends: Promise<unknown>[] = []
  for (const s of clients) {
    sends.push(s.send(json).catch(() => { clients.delete(s) }))
  }
  await Promise.all(sends)
}

let workerListenerInstalled = false

/** Worker-side: install a message listener that receives `dev-broadcast`
 * envelopes from the main process and forwards them to this worker's
 * local clients. Idempotent. */
export function installWorkerBroadcastListener(): void {
  if (workerListenerInstalled) return
  workerListenerInstalled = true
  // self === globalThis in Worker context. addEventListener is the safe
  // pattern (doesn't clobber any existing onmessage assignment).
  ;(globalThis as any).addEventListener('message', (e: MessageEvent) => {
    const data: any = (e as any).data
    if (data && data.type === 'dev-broadcast' && typeof data.json === 'string') {
      void broadcastLocal(data.json)
    }
  })
}

/** Main-side: relay the message to every worker via postMessage. Each
 * worker's installed message listener forwards to its local clients.
 * Per-worker postMessage failures are swallowed (worker may be already
 * terminating). */
export async function broadcast(msg: DevMessage): Promise<void> {
  const json = JSON.stringify(msg)
  const { _workersForTests } = await import('./worker-registry.ts')
  const workers = _workersForTests()
  for (const w of workers) {
    try { w.postMessage({ type: 'dev-broadcast', json }) }
    catch { /* worker already terminated; drop */ }
  }
}
