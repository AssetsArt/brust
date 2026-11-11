// F517 `[build] expose`: app modules a runtime component (one compiled after the build) imports. An exposed module is
// an entry of the same browser `Bun.build` as the native component chunks, so a built component that imports it and
// the entry URL a runtime component imports are ONE module instance in the browser (a store defined there stays one
// store). This file knows which modules, which stores they define, and the entry each one gets; `bundle.ts` builds it
// and `index.ts` writes the manifest's `runtime` block.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { BuildError } from './errors'

/** One exposed module: `rel` as written in the manifest (`/`-separated, relative to the app root), its real file, and the entry name. */
export interface ExposedModule {
  rel: string
  abs: string
  /** `client/x-<stem>-<hex10>.js` once built. */
  stem: string
  hasDefault: boolean
}

/** Specifiers `defineStore` is recognised from (the compiler's `STORE_API_SOURCES`, analyze/stores.rs). */
const STORE_API_SOURCES = ['@brust/core/store', '@brust/runtime-dom/store', '@brust/runtime-dom', 'brust/store']
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']
const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx' }

const read = (abs: string): string => readFileSync(abs, 'utf8')

/** A readable text of the file with block comments and whole-line comments blanked (the store scan matches code only). */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '')

/** The `x-<stem>` entry names: the file's own name, or its path when two exposed modules share one. */
function stems(rels: string[]): string[] {
  const base = (r: string) => (r.split('/').pop() ?? r).replace(/\.[^.]+$/, '')
  const slug = (r: string) =>
    r
      .replace(/\.[^./]+$/, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const count = new Map<string, number>()
  for (const r of rels) count.set(base(r), (count.get(base(r)) ?? 0) + 1)
  const used = new Set<string>()
  return rels.map((r) => {
    let s = (count.get(base(r)) ?? 0) > 1 ? slug(r) : base(r)
    s = s.replace(/[^A-Za-z0-9_-]/g, '-')
    for (let i = 2; used.has(s); i++) s = `${slug(r)}-${i}`
    used.add(s)
    return s
  })
}

/** The exposed modules of `[build] expose` (already validated by `parseExpose`): reads each one, so a file with no export is refused before a byte is written. */
export function exposedModules(appRoot: string, expose: string[]): ExposedModule[] {
  const names = stems(expose)
  return expose.map((rel, i) => {
    const abs = resolve(appRoot, rel)
    const src = read(abs)
    const scan = new Bun.Transpiler({ loader: LOADERS[extname(abs)] ?? 'ts' }).scan(src)
    if (scan.exports.length === 0 && !/\bexport\s*\*/.test(stripComments(src)))
      throw new BuildError('expose-not-module', `brust.toml: build.expose entry ${JSON.stringify(rel)} has no export: a runtime component imports names from it`)
    return { rel, abs: realOf(abs), stem: names[i]!, hasDefault: scan.exports.includes('default') }
  })
}

function realOf(f: string): string {
  try {
    return realpathSync(f)
  } catch {
    return f
  }
}

/** The entry text of an exposed module: its exports under their source names (the bundler keeps an entry's export names even when it minifies). */
export const wrapperSource = (m: ExposedModule): string => {
  const spec = JSON.stringify(m.abs)
  return `export * from ${spec}\n${m.hasDefault ? `export { default } from ${spec}\n` : ''}`
}

// ---- stores ----

/** A store a module exports: the name the browser registers it under, and the module that calls `defineStore`. */
interface StoreExport {
  exportName: string
  name: string
  def: string
}

/** The file a relative `spec` names from `from` (`./cart` → `./cart.ts`, `./cart/index.ts`), or undefined. */
function resolveRelative(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = resolve(dirname(from), spec)
  const isFile = (f: string) => {
    try {
      return statSync(f).isFile()
    } catch {
      return false
    }
  }
  if (isFile(base)) return base
  for (const e of EXTS) if (isFile(base + e)) return base + e
  for (const e of EXTS) if (isFile(join(base, `index${e}`))) return join(base, `index${e}`)
  return undefined
}

const MAX_DEPTH = 8

/**
 * Every `defineStore('<literal>', …)` an exposed module exports, by name: a direct `export const x = defineStore(…)`,
 * `export default defineStore(…)`, a local `export { x as y }`, and what `export { x } from './m'` / `export * from './m'`
 * / import-then-export reach (relative specifiers, depth ≤ 8, the way the compiler's store reader follows them). A name
 * that is not a string literal is skipped: no component can read that store from a runtime component either.
 */
function storesOf(abs: string, depth: number, seen: Set<string>): StoreExport[] {
  if (depth > MAX_DEPTH || seen.has(abs) || !existsSync(abs)) return []
  seen.add(abs)
  const src = stripComments(read(abs))
  const out: StoreExport[] = []
  // `defineStore` as this module spells it: a named (maybe renamed) import, or a member of a namespace import.
  const callees: string[] = []
  for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    if (!STORE_API_SOURCES.includes(m[3]!)) continue
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/)
      if (orig === 'defineStore') callees.push(`\\b${alias ?? orig}`)
    }
  }
  for (const m of src.matchAll(/\bimport\s*\*\s*as\s+(\w+)\s+from\s*(['"])([^'"]+)\2/g)) if (STORE_API_SOURCES.includes(m[3]!)) callees.push(`\\b${m[1]}\\s*\\.\\s*defineStore`)
  const own = new Map<string, string>() // local binding → store name, for a store this module defines
  if (callees.length > 0) {
    const call = `(?:${callees.join('|')})\\s*(?:<[^()]*>)?\\s*\\(\\s*(?<q>['"\`])(?<n>[^'"\`\\\\$]+)\\k<q>`
    for (const m of src.matchAll(new RegExp(`(export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*(?::[^=]+)?=\\s*${call}`, 'g'))) {
      own.set(m[2]!, m.groups!.n!)
      if (m[1]) out.push({ exportName: m[2]!, name: m.groups!.n!, def: abs })
    }
    for (const m of src.matchAll(new RegExp(`export\\s+default\\s+${call}`, 'g'))) out.push({ exportName: 'default', name: m.groups!.n!, def: abs })
  }
  // What a local `import { a as b } from './m'` brings in, by the local name.
  const imported = new Map<string, { file: string; exp: string }>()
  for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    const file = resolveRelative(abs, m[3]!)
    if (file === undefined) continue
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/)
      if (orig) imported.set(alias ?? orig, { file, exp: orig })
    }
  }
  const fromModule = (file: string, depthNow: number) => storesOf(file, depthNow, new Set(seen))
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?:\s*from\s*(['"])([^'"]+)\2)?/g)) {
    const target = m[3] === undefined ? undefined : resolveRelative(abs, m[3])
    const there = target === undefined ? undefined : fromModule(target, depth + 1)
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/)
      if (!orig) continue
      const exportName = alias ?? orig
      if (there !== undefined) {
        for (const s of there) if (s.exportName === orig) out.push({ ...s, exportName })
      } else if (own.has(orig)) out.push({ exportName, name: own.get(orig)!, def: abs })
      else if (imported.has(orig)) {
        const i = imported.get(orig)!
        for (const s of fromModule(i.file, depth + 1)) if (s.exportName === i.exp) out.push({ ...s, exportName })
      }
    }
  }
  for (const m of src.matchAll(/\bexport\s*\*\s*from\s*(['"])([^'"]+)\1/g)) {
    const file = resolveRelative(abs, m[2]!)
    if (file !== undefined) for (const s of fromModule(file, depth + 1)) if (s.exportName !== 'default') out.push(s)
  }
  return out
}

/** The manifest's `runtime` block (R1.3) and the store modules `jobs.js` must import (R1.4). */
export interface ExposedRuntime {
  /** Store name → the exposed module (`shop/sdk.ts`) that exports it. */
  stores: Record<string, string>
  /** The app-root-relative modules that call `defineStore` for those stores. */
  storeModules: string[]
}

export function exposedStores(appRoot: string, mods: ExposedModule[]): ExposedRuntime {
  const stores: Record<string, string> = {}
  const modules = new Set<string>()
  const root = realOf(appRoot)
  const rel = (f: string) => relative(root, f).split(sep).join('/')
  for (const m of mods) {
    for (const s of storesOf(m.abs, 0, new Set())) {
      if (stores[s.name] === undefined) stores[s.name] = m.rel
      modules.add(rel(s.def))
    }
  }
  return { stores: Object.fromEntries(Object.entries(stores).sort(([a], [b]) => (a < b ? -1 : 1))), storeModules: [...modules].sort() }
}
