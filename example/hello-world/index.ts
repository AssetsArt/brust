import { brust, isWorker, loadConfig, makeRenderer, buildIslands } from '../../runtime/index.ts'
import { routes } from './routes'

// Scope the scan to this dir — `bun test` runs from the brust repo root, so
// default cwd would otherwise pick up other example apps + test fixtures.
const { actions, sourceFiles } = await brust.scanActions({ roots: [import.meta.dirname] })

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
  // Tell Rust which literal paths are SSE — the accept loop dispatches
  // those via the SSE branch (long-lived tsfn call) instead of the render
  // pipeline. MVP supports literal paths only.
  const ssePaths = routes
    .filter((r) => r.chain[r.chain.length - 1].sse !== undefined)
    .map((r) => r.fullPath)
  if (ssePaths.length > 0) {
    brust.registerSsePaths(ssePaths)
    console.log(`[brust] main: registered ${ssePaths.length} sse path(s): ${ssePaths.join(', ')}`)
  }
  const wsPaths = routes
    .filter((r) => r.chain[r.chain.length - 1].websocket !== undefined)
    .map((r) => r.fullPath)
  if (wsPaths.length > 0) {
    brust.registerWsPaths(wsPaths)
    console.log(`[brust] main: registered ${wsPaths.length} ws path(s): ${wsPaths.join(', ')}`)
  }
  console.log(`[brust] main: scanActions found ${actions.length} action(s): ${actions.map((a) => a.id).join(', ')}`)

  // Build MCP manifest (main process only — workers read it from disk).
  const mcpManifest = await brust.buildMcpManifest({
    serverFiles: sourceFiles,
    routesFile: new URL('./routes.tsx', import.meta.url).pathname,
    sourceRoots: [import.meta.dirname],
    actions,
    routes,
  })
  console.log(`[brust] main: mcp manifest has ${mcpManifest.tools.length} tools + ${mcpManifest.resources.length} resources`)

  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
    actions,
    mcp: { manifest: mcpManifest },
  })
} else {
  const sab = new SharedArrayBuffer(256 * 1024)
  const view = new Uint8Array(sab)

  // Load the MCP manifest written by the main process and build a server.
  // Returns null if no manifest exists (MCP not configured).
  const mcpManifest = await brust.loadMcpManifest()
  let mcpServer: import('../../runtime/mcp/server.ts').McpServer | undefined
  if (mcpManifest) {
    const { makeMcpServer } = await import('../../runtime/mcp/server.ts')
    mcpServer = makeMcpServer({ manifest: mcpManifest, actions, routes })
    console.log(`[brust] worker: mcp server ready (${mcpManifest.tools.length} tools)`)
  }

  // Lazy getter — wid is null until registerRenderer returns.
  let wid: number | null = null
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid, mcp: mcpServer })
  wid = brust.registerRenderer(view, renderer)
}
