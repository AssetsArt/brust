import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { scanImports } from '../cli/native-routes-emit.ts'

const BEHAVIOR_RE = /export\s+const\s+behavior\b/

/** camelCase a component basename: lowercase the first character only. */
function registerName(sourcePath: string): string {
  const base = basename(sourcePath, extname(sourcePath))
  return base.length > 0 ? base[0]!.toLowerCase() + base.slice(1) : base
}

/** BFS the local import graph from the routes entry; return registerName →
 * absolute sourcePath for every file that has `export const behavior`. Throws on
 * two distinct files deriving the same register name. */
export function scanDirectiveComponents(routesEntryFile: string): Map<string, string> {
  const found = new Map<string, string>()
  const visited = new Set<string>()
  const queue: string[] = [...scanImports(routesEntryFile).values()]
  while (queue.length > 0) {
    const filePath = queue.shift() as string
    if (visited.has(filePath)) continue
    visited.add(filePath)
    let src = ''
    try {
      src = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    for (const dep of scanImports(filePath).values()) {
      if (!visited.has(dep)) queue.push(dep)
    }
    if (BEHAVIOR_RE.test(src)) {
      const name = registerName(filePath)
      const existing = found.get(name)
      if (existing && existing !== filePath) {
        throw new Error(
          `directive component name "${name}" derives from two files (${existing} and ${filePath}); component basenames must be app-unique`,
        )
      }
      found.set(name, filePath)
    }
  }
  return found
}
