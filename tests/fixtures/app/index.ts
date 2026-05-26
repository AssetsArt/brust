// Test fixture app — superset of example/hello-world used by
// tests/integration.test.ts. Mounts demo's six showcase routes PLUS all the
// failure-mode + middleware + action + variant routes that the integration
// suite depends on. Authors writing real apps should read
// example/hello-world/ instead — this file is intentionally cluttered.
import { brust, isWorker, loadConfig, makeRenderer, buildIslands } from '../../../runtime/index.ts'
import { routes } from './routes'

const { actions, sourceFiles } = await brust.scanActions({ roots: [import.meta.dirname] })

if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  const islands = await buildIslands(
    new URL('./island.config.ts', import.meta.url).pathname,
  )
  brust.configureIslandsDir(islands.outDir)
  console.log(`[brust] main: built ${islands.islandCount} island chunk(s)`)
  brust.registerRoutes(routes)
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

  const mcpManifest = await brust.loadMcpManifest()
  let mcpServer: import('../../../runtime/mcp/server.ts').McpServer | undefined
  if (mcpManifest) {
    const { makeMcpServer } = await import('../../../runtime/mcp/server.ts')
    mcpServer = makeMcpServer({ manifest: mcpManifest, actions, routes })
    console.log(`[brust] worker: mcp server ready (${mcpManifest.tools.length} tools)`)
  }

  let wid: number | null = null
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid, mcp: mcpServer })
  wid = brust.registerRenderer(view, renderer)
}
