// Package sources (shadcn S3 step 1, F153c, R34.61/R34.62): the compiler analyses a package component from the
// AUTHORED source its source map carries (`sourcesContent`), never from the published JS (G1, G2), and no package
// code runs here (G3: sources are read, transpiled for the integrity check, and written; never imported).
//
// For every bare import the app reaches (and, transitively, every bare import of a package source written here),
// the package's ESM entry is resolved, its `.map` read, and the `.ts`/`.tsx` sources written under
// `<app>/.brust/pkg-src/<name>@<version>-<hash>/` (keyed on the package's real path: bun's store installs one copy
// per dependant). The compiler gets the resolution map (`PackageSources`), so it reads only what this build wrote:
// the directory is removed first, and a stale one is never consulted.
//
// Fail closed: a package with no ESM entry, no map, no source for its entry, a source outside the package, a
// relative import the map does not carry, a dynamic `import()` or `eval`, or a source whose literals and names are
// not all in the published JS (R34.62: the React build runs the dist, not the map) is REFUSED, with the reason;
// the compiler then renders its components as React islands of the package export, exactly as before.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'

/** What the compiler reads (`AnalyzeOptions.packages`): per importing scope (`""` = the app, else the root-relative
 * directory of a written package), each bare specifier → the root-relative path of its written entry source, or the
 * reason it was refused. */
export interface PackageSources {
  scopes: Record<string, Record<string, string>>
  refused: Record<string, Record<string, string>>
  /** Each written directory (root-relative) → the package's real directory: a bare import in an artifact compiled from
   * a package source resolves from the package, as it does in a real install (not read by the compiler). */
  dirs: Record<string, string>
}

/** The last build's written directories (absolute) → the package's real directory, for the bundler. */
const writtenDirs = new Map<string, string>()

/** The real directory of the package whose written source `file` (absolute) is, if it is one. */
export function packageDirOf(file: string): string | undefined {
  for (const [dir, real] of writtenDirs) if (file.startsWith(dir + sep) || file.startsWith(`${dir}/`)) return real
  return undefined
}

/** Where the sources go, relative to the app root. */
export const PKG_SRC_DIR = '.brust/pkg-src'

/** Never followed: the React runtime itself, brust, and platform modules. */
const NEVER = (spec: string) =>
  /^(react|react-dom|scheduler)(\/|$)/.test(spec) ||
  /^(@brust\/|brust(\/|$)|brustjs(\/|$))/.test(spec) ||
  /^(node|bun):/.test(spec) ||
  // L23 inlines lucide icons from the package export; the icons pass owns them.
  /^lucide-react(\/|$)/.test(spec)

const LIMITS = { packages: 256, bytesPerPackage: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 }

type Outcome = { ok: true; dir: string; entry: string; imports: string[] } | { ok: false; reason: string }

/** `@scope/name/sub` → [`@scope/name`, `sub`]. */
export function splitSpecifier(spec: string): [string, string] {
  const parts = spec.split('/')
  const n = spec.startsWith('@') ? 2 : 1
  return [parts.slice(0, n).join('/'), parts.slice(n).join('/')]
}

/** The first `node_modules/<name>` from `from` upwards, as a real path. */
function findPackage(name: string, from: string): string | null {
  for (let dir = from; ; ) {
    const p = join(dir, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return realpathSync(p)
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** The package's ESM entry for `import` (exports `.` → `import`/`module`/`default`, then `module`). */
function esmEntry(pj: Record<string, unknown>): string | null {
  const pick = (x: unknown): string | null => {
    if (typeof x === 'string') return x
    if (!x || typeof x !== 'object') return null
    const o = x as Record<string, unknown>
    for (const k of ['import', 'module', 'default']) if (k in o) return pick(o[k])
    return null
  }
  const exp = pj.exports
  const dot = typeof exp === 'string' ? exp : exp && typeof exp === 'object' ? (exp as Record<string, unknown>)['.'] : undefined
  const viaExports = dot === undefined ? null : pick(dot)
  if (viaExports) return viaExports
  return typeof pj.module === 'string' ? pj.module : null
}

/** The source map of `file`: its `sourceMappingURL` (a relative file), else `<file>.map`. */
function mapOf(file: string): string | null {
  const text = readFileSync(file, 'utf8')
  const m = /\/\/# sourceMappingURL=([^\s'"]+)\s*$/.exec(text)
  if (m && !m[1]!.startsWith('data:') && !/^[a-z]+:/i.test(m[1]!)) {
    const p = join(dirname(file), m[1]!)
    if (existsSync(p)) return p
  }
  return existsSync(`${file}.map`) ? `${file}.map` : null
}

// ---------------------------------------------------------------------------------------------------------------
// Integrity (R34.62): every string/number literal and every name of the transpiled sources occurs in the published
// file the map belongs to. Both sides go through the same transpiler first, so quoting and type syntax agree.

/** Names the JSX transform and esbuild add or rename (`undefined` prints as `void 0`); not evidence either way. */
const JSX_NAMES = new Set(['createElement', '__name', '__defProp', 'React', 'undefined'])
const JSX_RUNTIME = /^(?:jsx|jsxs|jsxDEV|Fragment)(?:_[\w$]+)?$/
/** Keywords are syntax, not names: esbuild prints `const` as `var` and drops `type`/`interface` with the types. */
const KEYWORDS = new Set(
  'await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield async of get set as from type declare readonly abstract namespace module satisfies keyof infer is unique asserts override accessor'.split(' '),
)

export interface Skeleton {
  strings: Set<string>
  names: Set<string>
}

/** Literals and names of transpiled JS (a small lexer: strings, templates, comments, numbers, identifiers; a regex
 * literal may be read as names, which only makes a mismatch more likely: fail closed). */
export function skeleton(js: string): Skeleton {
  const strings = new Set<string>()
  const names = new Set<string>()
  let i = 0
  const n = js.length
  const templateDepth: number[] = []
  let braces = 0
  const readTemplateChunk = () => {
    // at the char after '`' or after the '}' that closes `${`
    let s = ''
    while (i < n) {
      const c = js[i]!
      if (c === '\\') {
        s += js.slice(i, i + 2)
        i += 2
      } else if (c === '`') {
        i++
        strings.add(s)
        return
      } else if (c === '$' && js[i + 1] === '{') {
        i += 2
        strings.add(s)
        templateDepth.push(braces)
        braces++
        return
      } else {
        s += c
        i++
      }
    }
  }
  while (i < n) {
    const c = js[i]!
    if (c === '/' && js[i + 1] === '/') {
      while (i < n && js[i] !== '\n') i++
    } else if (c === '/' && js[i + 1] === '*') {
      const end = js.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === '"' || c === "'") {
      let s = ''
      i++
      while (i < n && js[i] !== c) {
        if (js[i] === '\\') {
          s += js.slice(i, i + 2)
          i += 2
        } else s += js[i++]
      }
      i++
      strings.add(s)
    } else if (c === '`') {
      i++
      readTemplateChunk()
    } else if (c === '{') {
      braces++
      i++
    } else if (c === '}') {
      braces--
      i++
      if (templateDepth.length && templateDepth[templateDepth.length - 1] === braces) {
        templateDepth.pop()
        readTemplateChunk()
      }
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(js[i + 1] ?? ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))n?/.exec(js.slice(i))
      const tok = m ? m[0] : c
      const num = Number(tok.replace(/_/g, '').replace(/n$/, ''))
      strings.add(Number.isNaN(num) ? tok : `#${num}`)
      i += tok.length
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(js.slice(i))!
      names.add(m[0])
      i += m[0].length
    } else i++
  }
  return { strings, names }
}

const transpile = (code: string, loader: 'tsx' | 'ts' | 'js') =>
  new Bun.Transpiler({ loader, target: 'browser', minifyWhitespace: false, deadCodeElimination: false, trimUnusedImports: false }).transformSync(code)

/** What of `sources` is not in `published`; empty = the sources are what the published file was built from. */
export function integrityGaps(sources: { path: string; text: string }[], published: string): string[] {
  const pub = skeleton(transpile(published, 'js'))
  const gaps: string[] = []
  for (const s of sources) {
    const loader = s.path.endsWith('.tsx') ? 'tsx' : 'ts'
    const sk = skeleton(transpile(s.text, loader))
    // Import specifiers are module names, which bundling replaces; they are checked as imports instead.
    for (const im of new Bun.Transpiler({ loader }).scanImports(s.text)) sk.strings.delete(im.path)
    for (const v of sk.strings) if (!pub.strings.has(v)) gaps.push(`${s.path}: literal ${JSON.stringify(v.startsWith('#') ? v.slice(1) : v).slice(0, 60)}`)
    for (const v of sk.names) if (!JSX_NAMES.has(v) && !JSX_RUNTIME.test(v) && !KEYWORDS.has(v) && !pub.names.has(v)) gaps.push(`${s.path}: name \`${v}\``)
  }
  return gaps
}

// ---------------------------------------------------------------------------------------------------------------

/** Reads one package (real directory `dir`), checks it, and writes its sources under `outRoot`. */
function writePackage(appRoot: string, dir: string, budget: { bytes: number }): Outcome {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  const name = String(pj.name ?? '')
  const version = String(pj.version ?? '0.0.0')
  const entryRel = esmEntry(pj)
  if (!entryRel) return { ok: false, reason: 'no ESM entry (exports `import` or `module`)' }
  const entry = join(dir, entryRel)
  if (!existsSync(entry) || !statSync(entry).isFile()) return { ok: false, reason: `the ESM entry ${entryRel} is missing` }
  const mapFile = mapOf(entry)
  if (!mapFile) return { ok: false, reason: 'no source map for the ESM entry' }
  let map: { sources?: unknown; sourcesContent?: unknown }
  try {
    map = JSON.parse(readFileSync(mapFile, 'utf8'))
  } catch {
    return { ok: false, reason: 'the source map is not JSON' }
  }
  const sources = Array.isArray(map.sources) ? (map.sources as unknown[]) : []
  const contents = Array.isArray(map.sourcesContent) ? (map.sourcesContent as unknown[]) : []
  // Each source as a path inside the package; anything outside it, or not TS/TSX, is not ours to read.
  const files: { path: string; text: string }[] = []
  for (const [k, s] of sources.entries()) {
    const text = contents[k]
    if (typeof s !== 'string' || typeof text !== 'string') continue
    const abs = posix.normalize(posix.join(relative(dir, dirname(mapFile)).split(sep).join('/'), s))
    if (abs.startsWith('..') || posix.isAbsolute(abs) || /^[a-z]+:/i.test(s)) return { ok: false, reason: `the source ${s} lies outside the package` }
    if (!/\.tsx?$/.test(abs)) continue
    files.push({ path: abs, text })
  }
  if (files.length === 0) return { ok: false, reason: 'the source map carries no TypeScript sources (`sourcesContent`)' }
  const bytes = files.reduce((a, f) => a + f.text.length, 0)
  if (bytes > LIMITS.bytesPerPackage) return { ok: false, reason: `the sources are ${bytes} bytes (limit ${LIMITS.bytesPerPackage})` }
  if (budget.bytes + bytes > LIMITS.totalBytes) return { ok: false, reason: 'the package-source budget of this build is spent' }
  // Imports: relative ones must be in the map (the compiler would otherwise fail on them), bare ones are followed.
  const have = new Set(files.map((f) => f.path))
  const bare = new Set<string>()
  const imported = new Set<string>()
  for (const f of files) {
    if (/\beval\s*\(|\bnew\s+Function\b/.test(f.text)) return { ok: false, reason: `${f.path} calls eval or new Function` }
    let imports: { path: string; kind: string }[]
    try {
      imports = new Bun.Transpiler({ loader: f.path.endsWith('.tsx') ? 'tsx' : 'ts' }).scanImports(f.text)
    } catch (e) {
      return { ok: false, reason: `${f.path} does not parse: ${String(e instanceof Error ? e.message : e).split('\n')[0]}` }
    }
    for (const im of imports) {
      // The JSX transform's own runtime import (the transpiler adds it), and React itself.
      if (NEVER(im.path)) continue
      if (im.kind === 'dynamic-import' || im.kind === 'require-call' || im.kind === 'require-resolve') return { ok: false, reason: `${f.path} has a ${im.kind} (${im.path})` }
      if (im.path.startsWith('./') || im.path.startsWith('../')) {
        const base = posix.normalize(posix.join(posix.dirname(f.path), im.path))
        const hit = [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`].find((c) => have.has(c))
        if (hit) imported.add(hit)
        else return { ok: false, reason: `${f.path} imports ${im.path}, which the source map does not carry` }
      } else if (im.path.startsWith('/') || /^[a-z]+:/i.test(im.path)) return { ok: false, reason: `${f.path} imports ${im.path}` }
      else bare.add(im.path)
    }
  }
  // The entry source: the one `package.json#source` names, else the only source no other source imports.
  const declared = typeof pj.source === 'string' ? posix.normalize(pj.source.replace(/^\.\//, '')) : null
  const roots = files.filter((f) => !imported.has(f.path))
  const entrySrc = files.find((f) => f.path === declared) ?? (roots.length === 1 ? roots[0] : undefined)
  if (!entrySrc) return { ok: false, reason: `the source map has ${files.length} sources and none is the entry (no \`source\` field, ${roots.length} unimported)` }
  // R34.62: the published file must be what these sources were built into.
  let gaps: string[]
  try {
    gaps = integrityGaps(files, readFileSync(entry, 'utf8'))
  } catch (e) {
    return { ok: false, reason: `the integrity check could not read the sources or ${entryRel}: ${String(e instanceof Error ? e.message : e).split('\n')[0]}` }
  }
  if (gaps.length > 0) return { ok: false, reason: `the sources do not match the published ${entryRel} (${gaps.length} differences, first: ${gaps[0]})` }
  // Keyed on where the package sits relative to the app (stable across machines), not its absolute path.
  const hash = createHash('sha256').update(relative(appRoot, dir).split(sep).join('/')).digest('hex').slice(0, 8)
  const outRel = posix.join(PKG_SRC_DIR, `${name.replace('/', '+')}@${version}-${hash}`)
  for (const f of files) {
    const target = join(appRoot, outRel, f.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, f.text)
  }
  budget.bytes += bytes
  return { ok: true, dir: outRel, entry: posix.join(outRel, entrySrc.path), imports: [...bare].sort() }
}

/**
 * Writes the sources of every package `specs` reaches from the app (and of every package those sources import),
 * and returns the resolution map for the compiler. The directory is rebuilt from nothing on every call.
 */
export function preparePackageSources(appRoot: string, specs: Iterable<string>): PackageSources {
  const root = realpathSync(appRoot)
  rmSync(join(root, PKG_SRC_DIR), { recursive: true, force: true })
  const out: PackageSources = { scopes: {}, refused: {}, dirs: {} }
  writtenDirs.clear()
  const byDir = new Map<string, Outcome>()
  const budget = { bytes: 0 }
  // (scope, the real directory bare imports resolve from, specifier)
  const queue: [string, string, string][] = [...new Set(specs)].sort().map((s) => ['', root, s])
  const seen = new Set<string>()
  while (queue.length > 0) {
    const [scope, from, spec] = queue.shift()!
    const key = `${scope}\0${spec}`
    if (seen.has(key) || NEVER(spec)) continue
    seen.add(key)
    const refuse = (reason: string) => {
      ;(out.refused[scope] ??= {})[spec] = reason
    }
    const [name, sub] = splitSpecifier(spec)
    if (sub) {
      refuse('a package subpath import is not followed')
      continue
    }
    const dir = findPackage(name, from)
    if (!dir) {
      refuse('not installed')
      continue
    }
    let o = byDir.get(dir)
    if (!o) {
      try {
        o = byDir.size >= LIMITS.packages ? { ok: false, reason: `more than ${LIMITS.packages} packages` } : writePackage(root, dir, budget)
      } catch (e) {
        // An unreadable package.json or map is a refusal: a package never fails the build here.
        o = { ok: false, reason: `unreadable: ${String(e instanceof Error ? e.message : e).split('\n')[0]}` }
      }
      byDir.set(dir, o)
      // A refusal is reported where it matters: the compiler names it on the island it leaves (`external-component`).
      if (o.ok) {
        out.dirs[o.dir] = dir
        writtenDirs.set(join(root, o.dir), dir)
        for (const im of o.imports) queue.push([o.dir, dir, im])
      }
    }
    if (o.ok) (out.scopes[scope] ??= {})[spec] = o.entry
    else refuse(o.reason)
  }
  mkdirSync(join(root, PKG_SRC_DIR), { recursive: true })
  writeFileSync(join(root, PKG_SRC_DIR, 'index.json'), `${JSON.stringify(out, null, 2)}\n`)
  return out
}
