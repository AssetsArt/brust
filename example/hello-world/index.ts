import { brust, isWorker, loadConfig, makeRenderer } from '../../runtime/index.ts'
import { routes } from './routes'

if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  // Install the route table in Rust *before* serve() boots the accept loop.
  // Workers will load the same routes.tsx, so route_id (= array index) is
  // stable across main thread and every worker.
  brust.registerRoutes(routes)

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
    if (wid === '' || written < 2) return written
    // The first 2 bytes are the status prefix; the body starts at offset 2.
    const html = dec.decode(view.subarray(2, written))
    const patched = html.replace('worker_id=', `worker_id=${wid}`)
    if (patched === html) return written
    // Re-encode the patched body back into the SAB, preserving the prefix.
    const enc2 = new TextEncoder()
    const bodyView = view.subarray(2)
    const { written: w2 } = enc2.encodeInto(patched, bodyView)
    if (w2 === undefined) return 0
    return w2 + 2
  })
  wid = String(id)
}
