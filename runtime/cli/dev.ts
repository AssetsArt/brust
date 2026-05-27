import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
      if (!v) { console.error('brust dev: --port requires a value'); process.exit(1) }
      port = parseInt(v, 10)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`brust dev: invalid port ${v}`); process.exit(1)
      }
    } else if (a.startsWith('--port=')) {
      port = parseInt(a.slice('--port='.length), 10)
    } else if (a.startsWith('-')) {
      console.error(`brust dev: unknown flag ${a}`); process.exit(1)
    } else if (entry === undefined) {
      entry = a
    } else {
      console.error(`brust dev: unexpected positional argument ${a}`); process.exit(1)
    }
  }
  const cwd = process.cwd()
  const entryPath = entry
    ? (isAbsolute(entry) ? entry : resolve(cwd, entry))
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
  // Hand off to the user's entry. It calls brust.run() which, with
  // BRUST_DEV=1, enables dev wiring without requiring user edits.
  await import(pathToFileURL(entry).href)
}
