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

  // Lazy getter — wid is null until registerRenderer returns.
  let wid: number | null = null
  const renderer = makeRenderer(routes, view, { getWorkerId: () => wid })
  wid = brust.registerRenderer(view, renderer)
}
