// Resolving an import the way a runtime component's compile sees it: from the virtual directory of the file, against the real
// files of the app (the nearest `node_modules`, tsconfig `paths`), and the exposed modules by real path.
import { realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SCRIPT_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']
const isFile = (f: string): boolean => {
  try {
    return statSync(f).isFile()
  } catch {
    return false
  }
}
export const real = (f: string): string => {
  try {
    return realpathSync(f)
  } catch {
    return resolve(f)
  }
}

/** The file `spec` names from the virtual directory `from` (a relative path, or a package / alias from the app root). */
export function resolveSpec(spec: string, from: string, appRoot: string): string | undefined {
  if (spec.startsWith('.')) {
    const at = resolve(from, spec)
    for (const e of SCRIPT_EXT) if (isFile(at + e)) return real(at + e)
    for (const e of SCRIPT_EXT.slice(1)) if (isFile(join(at, `index${e}`))) return real(join(at, `index${e}`))
    return undefined
  }
  try {
    return real(Bun.resolveSync(spec, appRoot))
  } catch {
    return undefined
  }
}

/** The exposed modules by real path: what an import may name. */
export function exposedByPath(appRoot: string, exposed: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(exposed).map(([rel, file]) => [real(resolve(appRoot, rel)), file]))
}
