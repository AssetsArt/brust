import os from 'node:os'

import { brust, isWorker, makeRenderer } from '../../runtime/index.ts'
import { routes } from './routes'

const PORT_ENV = process.env.BRUST_PORT
const port = PORT_ENV ? parseInt(PORT_ENV, 10) : 3000
// Oversubscribe by 1.8× available cores: napi workers spend ~45% of wall time
// in V8 GC / IPC / thread-park; the extra workers keep CPU saturated during
// those pauses. Measured peak on M1 Pro (10C) at this ratio.
const defaultWorkers = Math.floor(os.availableParallelism() * 1.8)
const workers = parseInt(process.env.BRUST_WORKERS ?? String(defaultWorkers), 10)

if (!isWorker) {
  console.log(`[brust] main: spawning ${workers} worker threads`)

  // Install the route table in Rust *before* serve() boots the accept loop.
  // Workers will load the same routes.tsx, so route_id (= array index) is
  // stable across main thread and every worker.
  brust.registerRoutes(routes.map((r) => r.path))

  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
  })
} else {
  const sab = new SharedArrayBuffer(256 * 1024)
  const view = new Uint8Array(sab)

  let wid = ''
  const renderer = makeRenderer(routes, view)

  // Wrap renderer once to inject workerId into HelloWorld's `worker_id=` line
  // for the existing integration test. This is example-local; goes away when
  // loader/context lands.
  const dec = new TextDecoder()
  const id = brust.registerRenderer(view, async (envelopeJson) => {
    const written = await renderer(envelopeJson)
    if (wid === '') return written
    const html = dec.decode(view.subarray(0, written))
    const patched = html.replace('worker_id=', `worker_id=${wid}`)
    if (patched === html) return written
    const enc2 = new TextEncoder()
    const { written: w2 } = enc2.encodeInto(patched, view)
    return w2 ?? 0
  })
  wid = String(id)
}
