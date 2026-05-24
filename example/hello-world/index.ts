import { brust, isWorker, loadConfig, makeRenderer, buildIslands } from '../../runtime/index.ts'
import { routes } from './routes'

// Scope the scan to this dir — `bun test` runs from the brust repo root, so
// default cwd would otherwise pick up other example apps + test fixtures.
const actions = await brust.scanActions({ roots: [import.meta.dirname] })

if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  // Build islands BEFORE serve(): emits .brust/islands/<id>.js plus the
  // shared React runtime + bootstrap chunks.
  const islands = await buildIslands(
    new URL('./island.config.ts', import.meta.url).pathname,
  )
  brust.configureIslandsDir(islands.outDir)
  console.log(`[brust] main: built ${islands.islandCount} island chunk(s)`)
  // Install the route table in Rust *before* serve() boots the accept loop.
  // Workers will load the same routes.tsx, so route_id (= array index) is
  // stable across main thread and every worker.
  brust.registerRoutes(routes)
  console.log(`[brust] main: scanActions found ${actions.length} action(s): ${actions.map((a) => a.id).join(', ')}`)

  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
    actions,
  })
} else {
  const sab = new SharedArrayBuffer(256 * 1024)
  const view = new Uint8Array(sab)

  // Lazy getter — wid is null until registerRenderer returns.
  let wid: number | null = null
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid })
  wid = brust.registerRenderer(view, renderer)
}
