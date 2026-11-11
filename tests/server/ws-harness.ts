// Shared by tests/server/ws.test.ts and ws-dev.test.ts (F529): a WebSocket client with an inbox, and the status of a refused upgrade.
export interface Client {
  ws: WebSocket
  opened: Promise<void>
  closed: Promise<{ code: number; reason: string }>
  /** The next message, or a rejection after `ms`. */
  next(ms?: number): Promise<string | ArrayBuffer>
  /** Resolves true when no message arrives within `ms`. */
  quiet(ms: number): Promise<boolean>
}

/** Bun's WebSocket client takes `headers` (Origin, Cookie, any custom one) as a second-argument option. */
export function connect(url: string, headers: Record<string, string> = {}): Client {
  const ws = new WebSocket(url, { headers } as never)
  ws.binaryType = 'arraybuffer'
  const inbox: (string | ArrayBuffer)[] = []
  const waiters: ((v: string | ArrayBuffer) => void)[] = []
  ws.addEventListener('message', (e) => {
    const w = waiters.shift()
    if (w) w(e.data)
    else inbox.push(e.data)
  })
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error(`no open: ${(e as ErrorEvent).message ?? 'error'}`)))
  })
  opened.catch(() => {})
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })))
  const next = (ms = 5000) =>
    new Promise<string | ArrayBuffer>((resolve, reject) => {
      const got = inbox.shift()
      if (got !== undefined) return resolve(got)
      const t = setTimeout(() => reject(new Error(`no message within ${ms} ms`)), ms)
      waiters.push((v) => (clearTimeout(t), resolve(v)))
    })
  const quiet = (ms: number) =>
    new Promise<boolean>((resolve) => {
      if (inbox.length > 0) return resolve(false)
      const w = () => resolve(false)
      waiters.push(w)
      setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        resolve(true)
      }, ms)
    })
  return { ws, opened, closed, next, quiet }
}

/** The HTTP status a refused handshake answered: Bun reports it only as the text of the error event. */
export async function refusedStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  const c = connect(url, headers)
  try {
    await c.opened
  } catch (e) {
    const m = /status code: (\d+)/.exec(String((e as Error).message))
    if (m) return Number(m[1])
    throw e
  }
  c.ws.close()
  throw new Error(`the upgrade to ${url} was accepted`)
}
