import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

export interface CssDep {
  /** Absolute path to the .css or .module.css file. */
  path: string
  /** True iff the file ends with `.module.css`. */
  isModule: boolean
  /** Default-import binding name (e.g. `styles` for `import styles from ...`).
   * null for side-effect imports (`import './foo.css'`). */
  importedName: string | null
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.brust', 'dist'])
const SOURCE_EXT_RE = /\.(tsx?|jsx?)$/
const TEST_RE = /\.test\.(tsx?|jsx?)$/

/** Walk `scanRoot` recursively, parse every TS/TSX file with the TypeScript
 * compiler API, return a map of source file → CSS deps. Files outside
 * scanRoot, inside ignored dirs, or test files are skipped. */
export async function scanCssImports(scanRoot: string): Promise<Map<string, CssDep[]>> {
  const out = new Map<string, CssDep[]>()
  await walk(scanRoot, scanRoot, out)
  return out
}

async function walk(root: string, dir: string, out: Map<string, CssDep[]>): Promise<void> {
  let entries: string[]
  try { entries = await readdir(dir) }
  catch { return }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue
    const full = path.join(dir, name)
    let st
    try { st = await stat(full) } catch { continue }
    if (st.isDirectory()) {
      await walk(root, full, out)
    } else if (SOURCE_EXT_RE.test(name) && !TEST_RE.test(name)) {
      const deps = await depsForFile(full)
      if (deps.length > 0) out.set(full, deps)
    }
  }
}

async function depsForFile(file: string): Promise<CssDep[]> {
  const src = await readFile(file, 'utf-8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX)
  const deps: CssDep[] = []
  ts.forEachChild(sf, (node) => {
    if (!ts.isImportDeclaration(node)) return
    const spec = node.moduleSpecifier
    if (!ts.isStringLiteral(spec)) return
    const raw = spec.text
    if (!raw.endsWith('.css')) return
    const absPath = path.resolve(path.dirname(file), raw)
    const isModule = raw.endsWith('.module.css')
    let importedName: string | null = null
    if (node.importClause?.name) {
      // default import: `import styles from './x.module.css'`
      importedName = node.importClause.name.getText(sf)
    }
    deps.push({ path: absPath, isModule, importedName })
  })
  return deps
}
