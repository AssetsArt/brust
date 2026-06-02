import * as native from './index.js'
import type { EndpointDef } from './define-actions.ts'
import { loadConfig } from './config.ts'
import { configureCssEnabled, configureCssHrefsForRoute } from './css.ts'
import { configureJinjaDir } from './islands/native-render.ts'

export interface ServeOptions {
  /** Host/address to bind on. A hostname (e.g. `localhost`, resolved Rust-side)
   * or a literal IP such as `0.0.0.0` / `127.0.0.1`. */
  host: string
  port: number
  workers: number
  entry: string
  bootTimeoutMs?: number
  /** Actions builder from `defineActions(...)`. When present, `serve`
   * registers its endpoints (method/path, keyed by registration index)
   * before the listener binds. Optional — omit if the app has no actions. */
  actions?: import('./define-actions.ts').ActionsBuilder
  /** URL prefix the action router mounts under (e.g. `/_actions`). Threaded
   * into Rust's ServeOptions.action_prefix. */
  actionPrefix?: string
  /** MCP support — pass a manifest built via brust.buildMcpManifest. brust.serve
   * does NOT auto-wire MCP into workers; the worker branch of the entry file must
   * call brust.loadMcpManifest() + makeMcpServer() itself and pass the McpServer
   * to makeRenderer via `opts.mcp`. See example/pokedex/index.ts for the
   * pattern. The field here is currently unused inside serve() and is reserved
   * for future IPC-based propagation of the manifest. */
  mcp?: { manifest: import('./mcp/manifest.ts').McpManifest }
  /** Performance tunables. All optional — omitting any field keeps the
   * framework default, so the whole object is opt-in. `connWorkers` sets the
   * Rust-side connection-handling concurrency (accept→parse→dispatch), which is
   * INDEPENDENT of `workers` (the Bun render threads): I/O-bound paths like
   * `/ping` scale with `connWorkers`, render-bound paths scale with `workers`.
   * Setting `connWorkers > workers` is safe: a render dispatch that finds every
   * worker busy QUEUES (awaits a free worker up to `claimTimeoutMs`) instead of
   * 503-ing, so excess conn-workers just wait their turn rather than dropping
   * requests. */
  tuning?: {
    /** Rust accept/dispatch concurrency. Default = `workers`. */
    connWorkers?: number
    /** Max request bytes before header terminator. Default 16384 (16 KB). */
    maxRequestBytes?: number
    /** Max action/RPC body size. Default 262144 (256 KB). */
    maxActionBodyBytes?: number
    /** Accept-side queue depth (TCP backpressure point). Default 1024. */
    connQueueCap?: number
    /** Initial per-connection read buffer capacity. Default 4096. */
    readBufCap?: number
    /** Max ms a render waits for a free worker before 503 (AllBusy queues
     * instead of failing fast). Default 10000. */
    claimTimeoutMs?: number
  }
}

// Render callback. Resolves with a framed-response length: `> 0` → FAST LANE
// (the worker wrote `[meta_len][meta][body]` into the SAB; Rust reads it
// directly), `0` → the worker used the chunk channel via
// `napi.renderChunk(workerId, len)` (React Suspense streaming) or owns the
// socket independently (SSE/WS). The argument is a JSON envelope
// `{ route_id, path, params }` produced by Rust's route table — see
// runtime/routes.ts::RouteCall.
export type RenderFn = (envelopeJsonOrLen: number | string) => Promise<number>

// Bun Workers run in the same OS process as the main thread; the `env` option
// only patches the JS-visible process.env, not the native OS environment that
// Rust reads via std::env::var.  Read the flag here in JS instead.
export const isWorker: boolean = process.env.BRUST_WORKER_ID !== undefined

// native.workerId() reads a thread-local set by registerRenderer, so it must
// be re-evaluated at the point of use (not cached at module load).
export function workerId(): number | null {
  return (native as any).workerId()
}

// Sub-project J — boot-time jinja loader. The flag guards repeated calls across
// the main and worker branches of `run()` (and any embedded entrypoint that
// calls `registerRoutes` directly) so the env loads once at startup. Dev hot
// reload does NOT go through here — it reloads via reEmitJinja, which calls
// napiLoadJinjaTemplates directly (the Rust env is a reloadable RwLock now, not
// a load-once OnceLock).
let _jinjaLoaded = false
function loadJinjaOnce(dir: string): void {
  if (_jinjaLoaded) return
  ;(native as any).napiLoadJinjaTemplates(dir)
  _jinjaLoaded = true
}

function registerActionsInternal(endpoints: Array<{ method: string; path: string }>): number {
  return (native as any).registerActions(endpoints.map((e) => ({ method: e.method, path: e.path })))
}

/** Read and schema-validate a prebuilt mcp-manifest.json at an absolute path.
 *  Returns null if the file does not exist. Throws on malformed JSON or version mismatch. */
async function readManifestFromPath(
  absolutePath: string,
): Promise<import('./mcp/manifest.ts').McpManifest | null> {
  const f = Bun.file(absolutePath)
  if (!(await f.exists())) return null
  const text = await f.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`mcp-manifest.json is malformed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error(`mcp-manifest.json version mismatch (expected 1)`)
  }
  return parsed as import('./mcp/manifest.ts').McpManifest
}

export const brust = {
  async serve(opts: ServeOptions): Promise<void> {
    if (opts.actions) {
      // Register endpoint method/path with Rust. The router keys each by its
      // registration index; the worker dispatches on that same index string.
      registerActionsInternal(opts.actions.endpoints)
    }
    ;(native as any).beginServe({
      host: opts.host,
      port: opts.port,
      workers: opts.workers,
      entry: opts.entry,
      tuning: opts.tuning,
      // napi-rs camelCases #[napi(object)] fields, so the addon reads
      // `actionPrefix` (not snake_case). A snake_case key is silently dropped,
      // leaving the prefix at its default — which broke custom-prefix routing.
      actionPrefix: opts.actionPrefix,
    })
    const baseEnv = { ...process.env }
    const workersArr: Worker[] = []
    for (let i = 0; i < opts.workers; i++) {
      // Bun.Worker requires the JS entry (post-bundling). For the skeleton,
      // the entry is a TS file that Bun executes directly.
      workersArr.push(
        new Worker(opts.entry, {
          env: { ...baseEnv, BRUST_WORKER_ID: String(i) },
        }),
      )
    }
    if (process.env.BRUST_DEV === '1') {
      const { registerInitialPool } = await import('./dev/worker-registry.ts')
      registerInitialPool(workersArr, opts.entry, opts.workers, baseEnv as Record<string, string>)
    }
    // Bun Workers intercept SIGINT before Rust's ctrl_c() handler fires.
    // Install a JS-level handler so the process actually exits on SIGINT.
    process.on('SIGINT', () => process.exit(0))
    await (native as any).untilReady(opts.bootTimeoutMs ?? 5000)
    await (native as any).untilShutdown()
  },
  /** Install the route table in Rust. MUST be called before `serve()`.
   * Pass an array of FlatRoutes from `defineRoutes(...)` — each is JSON-encoded
   * with its optional cache config. Rust matches against `fullPath`. */
  registerRoutes(routes: import('./routes.ts').FlatRoute[]): number {
    const configs = routes.map((r) =>
      JSON.stringify({
        path: r.fullPath,
        cache: r.cache ?? null,
        nativeTemplate: r.nativeTemplate ?? null,
      }),
    )
    const result = (native as any).registerRoutes(configs)

    // Sub-project J — startup validation. Every native: true route's
    // Component.name must have a registered .jinja template, else 500 at
    // request time. Warn here so boot logs surface the misconfiguration
    // before any traffic hits.
    const expected = routes.filter((r) => r.nativeTemplate).map((r) => r.nativeTemplate!)
    if (expected.length > 0) {
      const registered = new Set<string>((native as any).napiListNativeTemplates() ?? [])
      for (const name of expected) {
        if (!registered.has(name)) {
          console.warn(
            `[brust] native: true route expects template "${name}.jinja" but it's not registered (boot warning — request will 500)`,
          )
        }
      }
    }
    return result
  },
  /** Register the list of literal route paths that should be dispatched as
   * SSE (text/event-stream) instead of going through the render pipeline.
   * Call from the main process after defineRoutes — the worker only needs
   * the call if it also accepts SSE traffic, but in the current model the
   * main accept loop owns dispatch so this is main-only. MVP supports only
   * literal paths; parameterized routes (e.g. `/sse/{room}`) are a follow-up. */
  registerSsePaths(paths: string[]): void {
    ;(native as any).napiRegisterSsePaths(paths)
  },
  /** Register the list of literal route paths that should be dispatched as
   * WebSocket upgrades. Call from the main process after defineRoutes.
   * MVP supports only literal paths — parameterized routes (e.g.
   * `/ws/chat/{room}`) are a follow-up. */
  registerWsPaths(paths: string[]): void {
    ;(native as any).napiRegisterWsPaths(paths)
  },
  /** Set the response cache capacity (entries). Default is 1000.
   * Safe to call at any time; if shrinking below current size, excess
   * LRU entries are evicted. */
  configureCache(opts: { maxEntries: number }): void {
    ;(native as any).configureCache(opts.maxEntries)
  },
  /** Tell Rust where to read `/_brust/islands/<file>` from. Called once at
   * boot after buildIslands() emits chunks. Path must be absolute. */
  configureIslandsDir(dir: string): void {
    ;(native as any).configureIslandsDir(dir)
  },
  /** Tell Rust where to read `/_brust/css/<file>` from. Called from the
   * main thread when CSS is configured. Path must be absolute. */
  configureCssDir(dir: string): void {
    ;(native as any).configureCssDir(dir)
  },
  /** Tell Rust where to read root-mapped static assets (`/favicon.ico`, …) from.
   * Path must be absolute. */
  configurePublicDir(dir: string): void {
    ;(native as any).configurePublicDir(dir)
  },
  /** Extract the MCP manifest from TypeScript source using the compiler API,
   * write it to `.brust/mcp-manifest.json`, and return it. Call once in the
   * main process after `brust.registerRoutes(routes)`. Workers must read the
   * persisted manifest themselves via `brust.loadMcpManifest()` in the worker
   * branch and pass an `McpServer` (built via `makeMcpServer`) to
   * `makeRenderer` via `opts.mcp`. See example/pokedex/index.ts. */
  async buildMcpManifest(opts: {
    actionsFile?: string
    routesFile: string
    sourceRoots: string[]
    routes: import('./routes.ts').FlatRoute[]
    cwd?: string
  }): Promise<import('./mcp/manifest.ts').McpManifest> {
    const { extractMcpManifest } = await import('./mcp/extractor.ts')
    const { writeManifest } = await import('./mcp/manifest.ts')
    const m = await extractMcpManifest(opts)
    await writeManifest(opts.cwd ?? process.cwd(), m)
    return m
  },
  /** Read the MCP manifest from `.brust/mcp-manifest.json`. Returns null if
   * the file does not exist (i.e. the main process hasn't called
   * `brust.buildMcpManifest` yet). Throws if the file is malformed. */
  async loadMcpManifest(
    cwd: string = process.cwd(),
  ): Promise<import('./mcp/manifest.ts').McpManifest | null> {
    const { readManifest } = await import('./mcp/manifest.ts')
    return readManifest(cwd)
  },
  // Register a renderer for this Bun Worker. `buf` MUST be backed by a SharedArrayBuffer
  // (or any ArrayBuffer the worker keeps rooted) — Rust captures the backing-store
  // pointer once here and reuses it for every render call. The buffer is held alive
  // by the worker's module scope; do not let it go out of scope.
  registerRenderer(buf: Uint8Array, fn: RenderFn): number {
    return (native as any).registerRenderer(buf, fn)
  },

  /**
   * One-call lifecycle: scans actions, builds islands (if `routes.tsx` uses
   * `<Island>`), registers routes + SSE/WS paths, builds the MCP manifest, then
   * branches to `serve()` (main thread) or registers a renderer (worker
   * thread). Replaces ~70 lines of boilerplate; the lower-level helpers
   * (`scanActions`, `registerRoutes`, `makeRenderer`, etc.) are still exported
   * for apps that need finer control.
   *
   * Conventions assumed (override via the corresponding option if your layout
   * differs):
   *   - `<scanRoot>/routes.tsx`       — scanned for `<Island>` usage (islands)
   *                                     and referenced by the MCP manifest builder
   *
   * `scanRoot` defaults to the directory of `entry` so the typical caller
   * passes only `{ routes, entry: import.meta.url }`.
   */
  async run(opts: {
    routes: import('./routes.ts').FlatRoute[]
    entry: string
    scanRoot?: string
    /** Host/address to bind on. Default `localhost`. A `brust dev --port` /
     * BRUST_PORT / BRUST_ADDR / brust.toml all override this app-level value
     * (precedence: env > toml > this > framework default). */
    address?: string
    /** TCP port to bind on. Default 1337. Overridable by env/toml — see
     * `address`. */
    port?: number
    /** Actions builder from `defineActions(...)`. Registered with Rust and
     * threaded to each worker's renderer. Omit if the app has no actions. */
    actions?: import('./define-actions.ts').ActionsBuilder
    /** URL prefix the action router mounts under. Threaded to serve(). */
    actionPrefix?: string
    /** Overrides merged into the underlying `serve()` call (main thread). */
    serve?: Partial<Omit<ServeOptions, 'entry' | 'actions' | 'mcp'>>
    /** Per-worker SAB size in bytes. Default 256 KB. */
    sabBytes?: number
    /** When true, prepend the dev WS route, install file watcher, set the
     * dev-client snippet, and start the TUI. Default false.
     * Also activated by BRUST_DEV=1 environment variable. */
    dev?: boolean
  }): Promise<void> {
    const { existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')

    const prebuilt = process.env.BRUST_PREBUILT === '1'
    const distDir = process.env.BRUST_DIST_DIR

    const scanRoot = opts.scanRoot ?? path.dirname(fileURLToPath(opts.entry))

    const dev = opts.dev === true || process.env.BRUST_DEV === '1'
    let routes = opts.routes
    if (dev) {
      const { createDevWsRoute } = await import('./dev/ws-channel.ts')
      const { buildDevClientTag } = await import('./dev/client.ts')
      const { configureDevClientSnippet } = await import('./dev/inject.ts')
      const devRoute = createDevWsRoute()
      routes = [
        { ...devRoute, fullPath: devRoute.path!, chain: [devRoute as any] } as any,
        ...opts.routes,
      ]
      configureDevClientSnippet(buildDevClientTag())
    }
    {
      const { configureActionPrefixSnippet } = await import('./render/inject-action-prefix.ts')
      const ap = opts.actionPrefix
      configureActionPrefixSnippet(
        ap && ap !== '/_brust/action'
          ? `<script>globalThis.__BRUST_ACTION_PREFIX__=${JSON.stringify(ap)}</script>`
          : null,
      )
    }
    // Actions now come from the explicit `defineActions(...)` builder passed in
    // opts (the `'use server'` scanner is gone). `endpoints` is the EndpointDef[]
    // threaded to serve()/makeRenderer; the worker keys dispatch by registration
    // index.
    const endpoints: EndpointDef[] = opts.actions?.endpoints ?? []

    if (!isWorker) {
      const { host, port, workers, cacheMaxEntries } = await loadConfig(process.cwd(), {
        host: opts.address,
        port: opts.port,
      })
      console.log(`[brust] main: spawning ${workers} worker threads`)
      if (cacheMaxEntries !== undefined) this.configureCache({ maxEntries: cacheMaxEntries })

      // Component CSS pipeline. Must run BEFORE buildIslands so the Bun.plugin
      // is active during island bundling — otherwise Bun's default loader would
      // see .module.css imports as separate asset outputs, producing duplicate-
      // output-path errors when an island and its module share a basename
      // (e.g. Counter.tsx + Counter.module.css → both want to emit Counter.js).
      {
        const { readComponentCssManifest } = await import('./css/manifest.ts')
        const { cssLoaderPlugin } = await import('./css/component-loader.ts')
        let manifest: import('./css/manifest.ts').ComponentCssManifest | null = null

        if (prebuilt) {
          const manifestPath = path.join(distDir!, 'css', 'component-manifest.json')
          manifest = await readComponentCssManifest(manifestPath)
        } else {
          const { scanCssImports } = await import('./css/scan-imports.ts')
          const scan = await scanCssImports(scanRoot)
          if (scan.size > 0) {
            const { buildComponentCss } = await import('./css/component-build.ts')
            const routeForCss = opts.routes.map((r) => ({
              fullPath: r.fullPath,
              componentSource: path.join(scanRoot, 'routes.tsx'),
            }))
            const cssOutDir = path.join(process.cwd(), '.brust', 'css')
            manifest = await buildComponentCss({
              scanRoot,
              outDir: cssOutDir,
              tailwindCompile: null,
              routes: routeForCss,
            })
            console.log(
              `[brust] main: built ${Object.keys(manifest.modules).length} component CSS chunk(s)`,
            )
          }
        }

        if (manifest) {
          Bun.plugin(cssLoaderPlugin(manifest))
          for (const [routePath, hrefs] of Object.entries(manifest.routeChunks)) {
            configureCssHrefsForRoute(routePath, hrefs)
          }
        }
      }

      if (prebuilt) {
        // Pre-built islands live at <distDir>/islands.
        const prebuiltIslandsDir = path.join(distDir!, 'islands')
        if (existsSync(prebuiltIslandsDir)) {
          this.configureIslandsDir(prebuiltIslandsDir)
          console.log(`[brust] main: using pre-built islands at ${prebuiltIslandsDir}`)
        }
      } else {
        const routesPath = path.join(scanRoot, 'routes.tsx')
        if (existsSync(routesPath)) {
          const { scanIslandChunks, buildIslands: build } = await import('./islands/build.ts')
          const islandMap = scanIslandChunks(routesPath)
          if (islandMap.size > 0) {
            const islands = await build(islandMap)
            this.configureIslandsDir(islands.outDir)
            console.log(`[brust] main: built ${islands.islandCount} island chunk(s)`)
          }
        }
      }

      // CSS pipeline — opt-in via convention: <scanRoot>/app.css.
      if (prebuilt) {
        const prebuiltCssDir = path.join(distDir!, 'css')
        if (existsSync(prebuiltCssDir)) {
          this.configureCssDir(prebuiltCssDir)
          configureCssEnabled(['/_brust/css/app.css'])
          console.log(`[brust] main: using pre-built CSS at ${prebuiltCssDir}`)
        }
      } else {
        const appCssPath = path.join(scanRoot, 'app.css')
        if (existsSync(appCssPath)) {
          const { buildCss } = await import('./css/build.ts')
          const cssOutDir = path.join(process.cwd(), '.brust', 'css')
          await buildCss({ entry: appCssPath, outDir: cssOutDir })
          this.configureCssDir(cssOutDir)
          configureCssEnabled(['/_brust/css/app.css'])
          console.log(`[brust] main: built CSS → ${cssOutDir}/app.css`)
        }
      }

      // Static public assets — convention: <scanRoot>/public (dev) or
      // <distDir>/public (prebuilt). Root-mapped (public/favicon.ico → /favicon.ico).
      if (prebuilt) {
        const prebuiltPublicDir = path.join(distDir!, 'public')
        if (existsSync(prebuiltPublicDir)) {
          this.configurePublicDir(prebuiltPublicDir)
          console.log(`[brust] main: serving static assets from ${prebuiltPublicDir}`)
        }
      } else {
        const publicDir = path.join(scanRoot, 'public')
        if (existsSync(publicDir)) {
          this.configurePublicDir(publicDir)
          console.log(`[brust] main: serving static assets from ${publicDir}`)
        }
      }

      // Sub-project J — load the compiled `*.jinja` templates into the minijinja
      // env so the startup-validation warning in registerRoutes can compare
      // against a populated registry. Loads once at startup; dev hot reload
      // reloads it. The templates ship INSIDE the build output, so a pre-built
      // run reads them (and their islands/components sidecars) from
      // `<distDir>/jinja`; dev compiles them to `cwd/.brust/jinja`.
      const jinjaDir = prebuilt
        ? path.join(distDir!, 'jinja')
        : path.resolve(process.cwd(), '.brust/jinja')
      configureJinjaDir(jinjaDir)
      loadJinjaOnce(jinjaDir)
      if (prebuilt && existsSync(jinjaDir)) {
        console.log(`[brust] main: using pre-built jinja at ${jinjaDir}`)
      }

      this.registerRoutes(routes)
      const ssePaths = routes
        .filter((r) => r.chain[r.chain.length - 1].sse !== undefined)
        .map((r) => r.fullPath)
      if (ssePaths.length > 0) {
        this.registerSsePaths(ssePaths)
        console.log(
          `[brust] main: registered ${ssePaths.length} sse path(s): ${ssePaths.join(', ')}`,
        )
      }
      const wsPaths = routes
        .filter((r) => r.chain[r.chain.length - 1].websocket !== undefined)
        .map((r) => r.fullPath)
      if (wsPaths.length > 0) {
        this.registerWsPaths(wsPaths)
        console.log(`[brust] main: registered ${wsPaths.length} ws path(s): ${wsPaths.join(', ')}`)
      }
      console.log(
        `[brust] main: registered ${endpoints.length} action endpoint(s): ${endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`,
      )

      if (dev) {
        // Tell Rust we're in dev so static assets (islands/CSS chunks) are
        // served `Cache-Control: no-store` — chunk URLs are unhashed, so a
        // hot-reload rebuild would otherwise be masked by the browser cache.
        // `?.` keeps an older addon (no export) from throwing.
        ;(native as any).configureDevMode?.(true)
        const { createWatcher } = await import('./dev/watcher.ts')
        const { Coordinator } = await import('./dev/coordinator.ts')
        const { broadcast } = await import('./dev/ws-channel.ts')
        const { Tui } = await import('./dev/tui.ts')
        const { terminateAll: termWorkers, spawnAll: spawnWorkers } = await import(
          './dev/worker-registry.ts'
        )
        const { reEmitJinja } = await import('./dev/jinja-reload.ts')
        const fsModule = await import('node:fs')
        const pathModule = await import('node:path')

        const tui = new Tui({
          isTty: process.stdout.isTTY === true,
          write: (s: string) => process.stdout.write(s),
        })
        // The banner's "Local" line is the ready signal — no separate event.
        tui.updateStatus({ port, workers, watching: [scanRoot] })

        const coordinator = new Coordinator({
          workers: {
            terminateAll: async () => {
              // Drop the outgoing generation's entries from the native render
              // pool BEFORE killing the Bun workers. Each entry holds a raw
              // pointer into the worker's SharedArrayBuffer (freed by
              // Worker.terminate()) plus a ThreadsafeFunction to its env.
              // Clearing while the workers are still alive releases each TSFN
              // cleanly and removes the stale entries, so no post-reload
              // request can write a render envelope into freed memory — the
              // use-after-free that crashed `brust dev` on the first request
              // after a hot reload. `?.` keeps an older addon (no reset export)
              // from throwing; it just falls back to the old behaviour.
              const dropped = (native as any).resetWorkerPool?.() ?? 0
              if (process.env.BRUST_DEV_DEBUG) {
                process.stderr.write(`[brust] dev: reset worker pool (dropped ${dropped})\n`)
              }
              await termWorkers()
            },
            spawnAll: async () => {
              await spawnWorkers()
            },
          },
          reEmitJinja,
          // Wipe the Rust-side island ISR cache on every render-affecting reload
          // so a frozen island render never survives a `.tsx` edit in dev.
          clearIslandCache: () => {
            ;(native as any).islandCacheClear?.()
          },
          buildCss: async () => {
            const appCss = pathModule.join(scanRoot, 'app.css')
            if (fsModule.existsSync(appCss)) {
              const { buildCss } = await import('./css/build.ts')
              const outDir = pathModule.join(process.cwd(), '.brust', 'css')
              await buildCss({ entry: appCss, outDir })
            }
          },
          buildIslands: async () => {
            const routesPath = pathModule.join(scanRoot, 'routes.tsx')
            if (fsModule.existsSync(routesPath)) {
              const { scanIslandChunks, buildIslands } = await import('./islands/build.ts')
              const islandMap = scanIslandChunks(routesPath)
              if (islandMap.size > 0) {
                await buildIslands(islandMap)
              }
            }
          },
          buildComponentCss: async () => {
            const { scanCssImports } = await import('./css/scan-imports.ts')
            const scan = await scanCssImports(scanRoot)
            if (scan.size === 0) return
            const { buildComponentCss } = await import('./css/component-build.ts')
            const { cssLoaderPlugin } = await import('./css/component-loader.ts')
            const routeForCss = opts.routes.map((r) => ({
              fullPath: r.fullPath,
              componentSource: pathModule.join(scanRoot, 'routes.tsx'),
            }))
            const cssOutDir = pathModule.join(process.cwd(), '.brust', 'css')
            const manifest = await buildComponentCss({
              scanRoot,
              outDir: cssOutDir,
              tailwindCompile: null,
              routes: routeForCss,
            })
            Bun.plugin(cssLoaderPlugin(manifest))
            for (const [rp, hrefs] of Object.entries(manifest.routeChunks)) {
              configureCssHrefsForRoute(rp, hrefs)
            }
          },
          snapshotComponentCss: async () => {
            const { readComponentCssManifest } = await import('./css/manifest.ts')
            const p = pathModule.join(process.cwd(), '.brust', 'css', 'component-manifest.json')
            return await readComponentCssManifest(p)
          },
          broadcast,
          tui: { appendEvent: (l) => tui.appendEvent(l) },
        })

        createWatcher({
          root: scanRoot,
          onChange: (ev) => {
            void coordinator.handleChange(ev)
          },
        })
      }

      let mcpManifest: import('./mcp/manifest.ts').McpManifest | null
      if (prebuilt) {
        const manifestPath = path.join(distDir!, 'mcp-manifest.json')
        mcpManifest = await readManifestFromPath(manifestPath)
        if (mcpManifest) {
          console.log(
            `[brust] main: loaded pre-built mcp manifest (${mcpManifest.tools.length} tools + ${mcpManifest.resources.length} resources)`,
          )
        }
      } else {
        const actionsFile = path.join(scanRoot, 'actions.ts')
        mcpManifest = await this.buildMcpManifest({
          actionsFile: existsSync(actionsFile) ? actionsFile : undefined,
          routesFile: path.join(scanRoot, 'routes.tsx'),
          sourceRoots: [scanRoot],
          routes,
        })
        console.log(
          `[brust] main: mcp manifest has ${mcpManifest.tools.length} tools + ${mcpManifest.resources.length} resources`,
        )
      }

      await this.serve({
        host,
        port,
        workers,
        entry: opts.entry,
        actions: opts.actions,
        actionPrefix: opts.actionPrefix,
        ...(mcpManifest ? { mcp: { manifest: mcpManifest } } : {}),
        ...opts.serve,
      })
    } else {
      // Worker branch
      let workerRoutes = opts.routes
      if (dev) {
        const { buildDevClientTag } = await import('./dev/client.ts')
        const { configureDevClientSnippet } = await import('./dev/inject.ts')
        configureDevClientSnippet(buildDevClientTag())
        const { createDevWsRoute, installWorkerBroadcastListener } = await import(
          './dev/ws-channel.ts'
        )
        installWorkerBroadcastListener()
        const devRoute = createDevWsRoute()
        workerRoutes = [
          { ...devRoute, fullPath: devRoute.path!, chain: [devRoute as any] } as any,
          ...opts.routes,
        ]
      }
      {
        const { configureActionPrefixSnippet } = await import('./render/inject-action-prefix.ts')
        const ap = opts.actionPrefix
        configureActionPrefixSnippet(
          ap && ap !== '/_brust/action'
            ? `<script>globalThis.__BRUST_ACTION_PREFIX__=${JSON.stringify(ap)}</script>`
            : null,
        )
      }
      // Worker: detect CSS the same way main did (no compile, no configureCssDir
      // — Rust state is shared, but the per-worker renderer needs the hrefs).
      if (prebuilt) {
        if (existsSync(path.join(distDir!, 'css'))) {
          configureCssEnabled(['/_brust/css/app.css'])
        }
      } else {
        if (existsSync(path.join(scanRoot, 'app.css'))) {
          configureCssEnabled(['/_brust/css/app.css'])
        }
      }

      // Worker: register the component CSS Bun.plugin so .module.css imports
      // resolve to the same hash map main saw. (Workers don't seed
      // configureCssHrefsForRoute — that's a renderer concern only on the
      // main thread.)
      {
        const { readComponentCssManifest } = await import('./css/manifest.ts')
        const { cssLoaderPlugin } = await import('./css/component-loader.ts')
        const manifestPath = prebuilt
          ? path.join(distDir!, 'css', 'component-manifest.json')
          : path.join(process.cwd(), '.brust', 'css', 'component-manifest.json')
        const manifest = await readComponentCssManifest(manifestPath)
        if (manifest) {
          Bun.plugin(cssLoaderPlugin(manifest))
        }
      }

      const sab = new SharedArrayBuffer(opts.sabBytes ?? 256 * 1024)
      const view = new Uint8Array(sab)

      let mcpManifest: import('./mcp/manifest.ts').McpManifest | null
      if (prebuilt) {
        const manifestPath = path.join(distDir!, 'mcp-manifest.json')
        mcpManifest = await readManifestFromPath(manifestPath)
      } else {
        mcpManifest = await this.loadMcpManifest()
      }
      let mcpServer: import('./mcp/server.ts').McpServer | undefined
      if (mcpManifest) {
        const { makeMcpServer } = await import('./mcp/server.ts')
        mcpServer = makeMcpServer({ manifest: mcpManifest, endpoints, routes: workerRoutes })
        console.log(`[brust] worker: mcp server ready (${mcpManifest.tools.length} tools)`)
      }

      // Sub-project J note: jinja templates are loaded ONCE process-wide by the
      // main branch's loadJinjaOnce call. Rust's ENV is a process-global
      // OnceLock; Bun Workers share that process, so calling it from each
      // worker would panic on second set(). The worker reads ENV.get() at
      // napi_render_jinja time — no per-worker load needed.

      const { makeRenderer: make } = await import('./routes.ts')
      let wid: number | null = null
      const renderer = make(workerRoutes, view, {
        actions: endpoints,
        getWorkerId: () => wid,
        mcp: mcpServer,
      })
      wid = this.registerRenderer(view, renderer)
    }
  },
}

export {
  defineRoutes,
  makeRenderer,
  Outlet,
  notFound,
  redirect,
  isNativeVerdict,
} from './routes.ts'
export type {
  Route,
  RouteCall,
  RouteContext,
  ErrorBoundaryProps,
  RouteCacheConfig,
  BrustRequest,
  RouteResponse,
  Middleware,
  NativeVerdict,
} from './routes.ts'

export { defineActions, isValidEndpointPath } from './define-actions.ts'
export type {
  EndpointDef,
  ActionContext,
  EndpointOptions,
  ActionsBuilder,
} from './define-actions.ts'

export { loadConfig, BrustConfigError } from './config.ts'
export type { BrustConfig } from './config.ts'

export { Island } from './islands/island.tsx'
export type { IslandProps, HydrateTrigger } from './islands/island.tsx'
// Side-effect import (NOT type-only) so the `react` JSX augmentation in
// isr-jsx.ts is pulled into the program of any project that value-imports
// brustjs — a type-only re-export would be elided and the augmentation lost.
// The augmentation makes `isr` valid on any component, like `key`. (Compiles to
// an empty module; harmless at runtime.)
import './islands/isr-jsx.ts'
export type { IsrConfig } from './islands/isr-jsx.ts'

export { BrustPage } from './islands/brust-page.tsx'
export type { BrustPageProps, HeadEntry } from './islands/brust-page.tsx'

export { useStore } from './store/react.ts'

export { buildIslands } from './islands/build.ts'
export type { IslandsBuildResult, BuildIslandsOptions } from './islands/build.ts'

export { cache } from './cache.ts'
export type { InvalidateArgs } from './cache.ts'
