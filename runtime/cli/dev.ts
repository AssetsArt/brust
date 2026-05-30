import { existsSync } from 'node:fs'
import path, { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emitNativeTemplates } from './native-routes-emit.ts'

/** repoRoot = the directory that contains runtime/. This file lives at
 * runtime/cli/dev.ts so two dirname() steps get us there. */
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')

interface ParsedArgs {
  entry: string
  port: number | undefined
}

function parseArgs(args: string[]): ParsedArgs {
  let entry: string | undefined
  let port: number | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port') {
      const v = args[++i]
      if (!v) {
        console.error('brust dev: --port requires a value')
        process.exit(1)
      }
      port = parseInt(v, 10)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`brust dev: invalid port ${v}`)
        process.exit(1)
      }
    } else if (a.startsWith('--port=')) {
      port = parseInt(a.slice('--port='.length), 10)
    } else if (a.startsWith('-')) {
      console.error(`brust dev: unknown flag ${a}`)
      process.exit(1)
    } else if (entry === undefined) {
      entry = a
    } else {
      console.error(`brust dev: unexpected positional argument ${a}`)
      process.exit(1)
    }
  }
  const cwd = process.cwd()
  const entryPath = entry
    ? isAbsolute(entry)
      ? entry
      : resolve(cwd, entry)
    : resolve(cwd, 'index.ts')
  if (!existsSync(entryPath)) {
    console.error(`brust dev: no entry file at ${entryPath}; pass a path or create ./index.ts`)
    process.exit(1)
  }
  return { entry: entryPath, port }
}

export async function runDev(args: string[]): Promise<void> {
  const { entry, port } = parseArgs(args)
  process.env.BRUST_DEV = '1'
  if (port !== undefined) process.env.BRUST_PORT = String(port)

  // Sub-project J — emit .brust/jinja/<Name>.jinja templates BEFORE handing
  // off to the user's entry. The runtime loads these on boot. Dev-mode HMR
  // on .tsx edit is deferred per spec §12 (restart-to-reload for v2).
  const entryDir = dirname(entry)
  const routesFile = path.join(entryDir, 'routes.tsx')
  let loadedRoutes: any[] = []
  if (existsSync(routesFile)) {
    try {
      const mod = await import(routesFile)
      loadedRoutes = mod.routes ?? []
    } catch (err) {
      console.warn(
        `[brust dev] failed to pre-load routes for jinja emit: ${(err as Error).message}`,
      )
    }
  }
  // Spec §7 — scan routes.tsx (where page imports live), not the app entry.
  // outDir = process.cwd() to align with the runtime's loadJinjaOnce which
  // reads from `cwd + '.brust/jinja'`. When user runs `bun run dev
  // example/hello-world/index.ts` from repo root, cwd != entryDir; writing
  // to entryDir would put templates somewhere the runtime never looks.
  const jinjaDir = path.join(process.cwd(), '.brust/jinja')
  const emitOpts = {
    entryFile: existsSync(routesFile) ? routesFile : entry,
    flatRoutes: loadedRoutes as { nativeTemplate?: string }[],
    outDir: jinjaDir,
    repoRoot: REPO_ROOT,
  }
  await emitNativeTemplates(emitOpts)

  // Native-route HMR: on a ts/html/islands hot reload the dev coordinator calls
  // this to recompile the .jinja templates from the (edited) source and reload
  // them into the minijinja env — so `native: true` routes pick up edits without
  // a dev-server restart. The runtime (loaded by the entry import below) holds
  // napiLoadJinjaTemplates via the napi loader at `../index.js`; the Rust env is
  // a reloadable RwLock. Adding/removing routes still needs a restart (the route
  // structure is captured here at startup).
  const { registerJinjaReEmit } = await import('../dev/jinja-reload.ts')
  registerJinjaReEmit(async () => {
    await emitNativeTemplates(emitOpts)
    const native = await import('../index.js')
    ;(native as { napiLoadJinjaTemplates: (dir: string) => unknown }).napiLoadJinjaTemplates(
      jinjaDir,
    )
  })

  // Hand off to the user's entry. It calls brust.run() which, with
  // BRUST_DEV=1, enables dev wiring without requiring user edits.
  await import(pathToFileURL(entry).href)
}
