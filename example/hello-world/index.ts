import { brust, isWorker, loadConfig, makeRenderer, buildIslands, defineActions, type Middleware } from '../../runtime/index.ts'
import { routes } from './routes'
import { createNote, whoAmI, deleteNote, pingAction } from './actions'

// Auth middleware to demo on the deleteNote action.
const requireUser: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return { status: 401, body: 'login required' }
  }
  return next()
}

const actions = defineActions([
  { id: 'createNote', fn: createNote },
  { id: 'whoAmI',     fn: whoAmI },
  { id: 'deleteNote', fn: deleteNote, middleware: [requireUser] },
  { id: 'pingAction', fn: pingAction },
])

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
  brust.registerActions(actions)
  console.log(`[brust] main: registered ${actions.length} action(s)`)

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
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid })
  wid = brust.registerRenderer(view, renderer)
}
