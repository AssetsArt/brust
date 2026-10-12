// A CacheAdapter over HTTP + WebSocket to tests/server/l2-relay.ts. Every failure is a rejected
// promise the runtime already handles (fail-open); the socket never throws into the worker.
import type { CacheAdapter, InvalidationEvent, StoredPage } from '@brust/core/cache-adapter'

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

export function relayAdapter(base: string): CacheAdapter {
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(`relay ${path}: ${r.status}`)
    return r.json()
  }
  return {
    name: 'relay',
    runtimes: ['bun'],
    store: {
      maxBodyBytes: 8_388_608,
      async get(key) {
        const r = await post('/get', { key })
        const page: StoredPage | null = r.page ? { status: r.page.status, headers: r.page.headers, body: unb64(r.page.body) } : null
        return { page, stamp: r.stamp, entryStamp: r.entryStamp, storedAt: r.storedAt }
      },
      async set(key, page, meta) {
        return (await post('/set', { key, page: { status: page.status, headers: page.headers, body: b64(page.body) }, meta })).ok
      },
      async invalidate(args) {
        await post('/invalidate', { args })
      },
    },
    broadcast: {
      async publish(args, origin) {
        return (await post('/publish', { args, origin })).seq
      },
      async subscribe(on: (e: InvalidationEvent) => void, onGap: () => void) {
        let closed = false
        let ws: WebSocket | null = null
        const connect = (reconnect: boolean) =>
          new Promise<void>((resolve) => {
            const s = new WebSocket(`${base.replace(/^http/, 'ws')}/sub`)
            ws = s
            s.onopen = () => {
              if (reconnect) onGap()
              resolve()
            }
            s.onmessage = (m) => {
              try {
                const e = JSON.parse(String(m.data))
                if (e.gap) onGap()
                else on(e as InvalidationEvent)
              } catch {}
            }
            s.onerror = () => resolve()
            s.onclose = () => {
              resolve()
              if (closed) return
              onGap()
              setTimeout(() => void connect(true).catch(() => {}), 500)
            }
          })
        await connect(false)
        return async () => {
          closed = true
          ws?.close()
        }
      },
    },
  }
}
