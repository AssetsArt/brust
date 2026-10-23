// CSS for `brust build` (gaps round L19, R19.1-R19.4): which stylesheets each route links, one
// minified content-hashed `client/<stem>-<hex10>.css` per source file, the class maps of CSS
// Modules, and the one plugin every JS build uses so no JS build ever emits CSS.
//
// - A route's CSS: `[css] global` first, then every `.css` import reachable from its chain files
//   (root layout → page), depth-first in import order, first occurrence wins.
// - CSS Modules: one in-process Bun.build of every source (a JS entry per file), so one set of class
//   names serves the server (jobs.js), the browser chunks and the Cloudflare worker alike.
// - Relative `url()` fonts and images are emitted next to the CSS as `client/<name>-<hex10>.<ext>`;
//   absolute `/public/*` and `/_brust/*` stay as written.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BunPlugin } from 'bun'
import type { FlatRoute } from '../routes'
import { BuildError } from './errors'
import { loadTailwind } from './tailwind'

const hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 10)
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const isCss = (p: string) => p.endsWith('.css')
const isModule = (p: string) => p.endsWith('.module.css')
/** A name the static rules serve (`[A-Za-z0-9_.-]`, no leading dot). */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_')

/** The stylesheets one source file reaches through static and dynamic imports, in order, real paths. Source
 * files outside node_modules are followed; a `.css` import (an app file or a package's CSS) is
 * collected, never followed (its `@import`s are the CSS bundler's). */
export class CssGraph {
  private memo = new Map<string, string[]>()
  private active = new Set<string>()
  private transpilers = new Map<string, InstanceType<typeof Bun.Transpiler>>()

  of(file: string): string[] {
    const f = real(file)
    const hit = this.memo.get(f)
    if (hit) return hit
    if (this.active.has(f)) return [] // an import cycle: the outer visit already lists what follows
    this.active.add(f)
    const out: string[] = []
    const add = (c: string) => {
      if (!out.includes(c)) out.push(c)
    }
    const loader = /\.(tsx|ts|jsx|js|mjs)$/.exec(f)?.[1]
    let src = ''
    try {
      src = loader ? readFileSync(f, 'utf8') : ''
    } catch {}
    if (loader && src) {
      const l = loader === 'mjs' ? 'js' : (loader as 'tsx' | 'ts' | 'jsx' | 'js')
      let t = this.transpilers.get(l)
      if (!t) this.transpilers.set(l, (t = new Bun.Transpiler({ loader: l })))
      for (const imp of t.scanImports(src)) {
        // A dynamic import() is walked too (review N4): its CSS is linked eagerly for the route, so a
        // lazily loaded component is styled on first paint and its CSS Modules are built.
        if (imp.kind !== 'import-statement' && imp.kind !== 'dynamic-import') continue
        let dep: string
        try {
          dep = real(Bun.resolveSync(imp.path, dirname(f)))
        } catch {
          continue // unresolvable: the JS build reports it
        }
        if (isCss(dep)) add(dep)
        else if (!dep.split(sep).includes('node_modules')) for (const c of this.of(dep)) add(c)
      }
    }
    this.active.delete(f)
    this.memo.set(f, out)
    return out
  }
}

/** R19.1: every route's ordered source stylesheets (real paths), by route id. `chainFiles` maps a leaf to
 * its chain's component files, root layout first. */
export function routeCssSources(leaves: FlatRoute[], chainFiles: (l: FlatRoute) => string[], globals: string[], graph = new CssGraph()): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const leaf of leaves) {
    const list: string[] = [...globals]
    for (const file of chainFiles(leaf)) for (const c of graph.of(file)) if (!list.includes(c)) list.push(c)
    out.set(leaf.id, list)
  }
  return out
}

/** `[css] global` resolved: each a `.css` file inside the app. */
export function resolveGlobals(appRoot: string, globals: string[]): string[] {
  return globals.map((g) => {
    const abs = resolve(appRoot, g)
    const rel = relative(appRoot, abs)
    if (isAbsolute(g) || rel.startsWith('..') || isAbsolute(rel) || !existsSync(abs)) throw new BuildError('css', `css.global ${g} is not a file inside the app`)
    return real(abs)
  })
}

export interface CssBuild {
  /** source (real path) → `client/<stem>-<hex10>.css`; absent when the file emits no CSS. */
  file: Map<string, string>
  /** `.module.css` source (real path) → its class map. */
  maps: Map<string, Record<string, string>>
}

const CLASS = /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g

/** The asset types `static_rules::is_safe_client_asset_filename` serves from `/_brust/client/` (review N1). */
export const SERVED_ASSET_EXT = ['.woff2', '.woff', '.ttf', '.otf', '.eot', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico']

const SOURCE_URL = /url\(\s*(["']?)([^"')]+?)\1\s*\)/g

/** F393: a `url()` that is the absolute path of a file on disk (see the `loader` in `buildCss`) becomes a
 * hashed `./<name>-<hex10>.<ext>` client asset at any size. `/public/…` and `/_brust/…` stay as written. */
function emitSourceAssets(text: string, assets: { name: string; bytes: Uint8Array }[], suffixed: Map<string, string>): string {
  const emit = (path: string, suffix: string) => {
    const bytes = new Uint8Array(readFileSync(path))
    const name = `${safeName(basename(path, extname(path)))}-${hex(bytes)}${extname(path).toLowerCase()}`
    if (!assets.some((a) => a.name === name)) assets.push({ name, bytes })
    return /^[^\s"'()\\]*$/.test(suffix) ? `url(./${name}${suffix})` : `url("./${name}${suffix.replace(/["\\]/g, '\\$&')}")`
  }
  return text.replace(SOURCE_URL, (whole, _q: string, path: string) => {
    const abs = suffixed.get(path)
    if (abs !== undefined) return emit(abs, path.slice(path.search(/[?#]/)))
    const ext = extname(path).toLowerCase()
    if (!path.startsWith('/') || !SERVED_ASSET_EXT.includes(ext) || path.startsWith('/public/') || path.startsWith('/_brust/') || !existsSync(path)) return whole
    return emit(path, '')
  })
}

/** F393: a `url()` asset with a `?query` / `#fragment` (`?v=3`, `?#iefix`, an SVG font's `#id`) is not given
 * Bun's path form: a plugin-resolved specifier is printed as written. This plugin resolves such a specifier
 * itself and records the file it names, so `emitSourceAssets` can copy it and keep the suffix verbatim. The
 * same text naming two different files (from two importers) fails the build rather than guess. */
function suffixPlugin(suffixed: Map<string, string>): BunPlugin {
  return {
    name: 'brust-css-asset-suffix',
    setup(b) {
      b.onResolve({ filter: /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)[?#]/i }, (a) => {
        const at = a.path.search(/[?#]/)
        const file = a.path.slice(0, at)
        let abs: string
        try {
          abs = file.startsWith('.') || isAbsolute(file) ? resolve(dirname(a.importer), file) : Bun.resolveSync(file, dirname(a.importer))
        } catch {
          return undefined
        }
        if (!existsSync(abs)) return undefined
        const have = suffixed.get(a.path)
        if (have !== undefined && have !== abs) throw new BuildError('css-asset-ambiguous', `url(${a.path}) names ${have} and ${abs}; give them different specifiers`)
        suffixed.set(a.path, abs)
        return { path: abs }
      })
    },
  }
}

/** R19.2/R19.4: builds every source stylesheet (one JS entry each) into `<dist>/client/`. `minify`
 * is off only for a development build (`brust dev`, review N3). */
export async function buildCss(
  dist: string,
  sources: string[],
  minify = true,
  o: { appRoot?: string; log?: (s: string) => void } = {},
): Promise<CssBuild> {
  const file = new Map<string, string>()
  const maps = new Map<string, Record<string, string>>()
  if (sources.length === 0) return { file, maps }
  const appRoot = o.appRoot ?? process.cwd()
  const tw = tailwindUse(sources)
  const plugins: BunPlugin[] = []
  if (tw.using.length > 0) {
    // a stylesheet compiles with Tailwind when it, or a relative @import of it, uses Tailwind
    const via = new Map<string, boolean>()
    const uses = (f: string) => {
      const k = real(f)
      let hit = via.get(k)
      if (hit === undefined) via.set(k, (hit = tailwindUse([k]).using.length > 0))
      return hit
    }
    plugins.push(await loadTailwind(appRoot, tw.using[0]!, uses, o.log))
    if (tw.imports.length > 1)
      o.log?.(
        `[brust] warning tailwind @import "tailwindcss" is in ${tw.imports.length} files (${tw.imports.map((f) => relative(appRoot, f)).join(', ')}): each one ships the whole of Tailwind; import it once (e.g. app.css) and use @reference elsewhere`,
      )
  }
  const stage = join(dist, '.stage', 'css')
  mkdirSync(stage, { recursive: true })
  const entries = sources.map((src, i) => {
    const e = join(stage, `s${i}.js`)
    writeFileSync(e, isModule(src) ? `export { default } from ${JSON.stringify(src)}\n` : `import ${JSON.stringify(src)}\n`)
    return e
  })
  const suffixed = new Map<string, string>()
  plugins.push(suffixPlugin(suffixed))
  const res = await Bun.build({
    entrypoints: entries,
    target: 'browser',
    format: 'esm',
    minify,
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    external: ['/public/*', '/_brust/*'],
    root: appRoot,
    plugins,
    // F393, verified on Bun 1.4.4 only: its CSS bundler turns an asset under the size threshold into a `data:`
    // URI whatever `loader: file` says, and `loader: dataurl` does the opposite (the name is inverted): it leaves
    // the url() as the absolute path of the source file. That path is the marker `emitSourceAssets` copies and
    // rewrites. Re-check on every Bun upgrade; the F393 tests in test/css.test.ts go red if the quirk changes.
    loader: Object.fromEntries(SERVED_ASSET_EXT.map((e) => [e, 'dataurl'])),
  })
  if (!res.success) throw new BuildError('css', res.logs.map(String).join('\n'))
  // Assets a stylesheet references (fonts, images): `<name>-<hex10>.<ext>`, references rewritten.
  const rename = new Map<string, string>()
  const assets: { name: string; bytes: Uint8Array }[] = []
  const css = new Map<number, string>()
  const js = new Map<number, string>()
  const unserved: string[] = []
  for (const o of res.outputs) {
    const name = basename(o.path)
    const entry = /^s(\d+)-[^-.]+\.(css|js)$/.exec(name)
    if (entry) {
      ;(entry[2] === 'css' ? css : js).set(Number(entry[1]), await o.text())
      continue
    }
    const m = /^(.*)-[^-.]+(\.[^.]+)$/.exec(name)
    if (!m) throw new BuildError('css', `unexpected output ${name}`)
    const ext = m[2]!.toLowerCase()
    if (!SERVED_ASSET_EXT.includes(ext)) {
      unserved.push(name)
      continue
    }
    const bytes = new Uint8Array(await o.arrayBuffer())
    const to = `${safeName(m[1]!)}-${hex(bytes)}${ext}`
    rename.set(name, to)
    assets.push({ name: to, bytes })
  }
  // Fail closed (review N1): an asset the server would not serve from /_brust/client would 404.
  if (unserved.length > 0) {
    const lines = unserved.map((name) => {
      const by = sources.filter((_, i) => css.get(i)?.includes(name))
      const [, stem, ext] = /^(.*)-[^-.]+(\.[^.]+)$/.exec(name)!
      return `${stem}${ext} (url() in ${by.join(', ') || 'a stylesheet'})`
    })
    throw new BuildError(
      'css-asset-type',
      `${lines.join('; ')}: brust serves only ${SERVED_ASSET_EXT.join(' ')} from /_brust/client; put the file in public/ and reference it as /public/…`,
    )
  }
  for (const [i, t] of css) css.set(i, emitSourceAssets(t, assets, suffixed))
  for (const a of assets) writeFileSync(join(dist, 'client', a.name), a.bytes)
  for (const [i, src] of sources.entries()) {
    let text = css.get(i)
    if (text !== undefined && text.trim() !== '') {
      for (const [from, to] of rename) text = text.split(from).join(to)
      const stem = safeName(basename(src).replace(/\.css$/, ''))
      const out = `${stem}-${hex(text)}.css`
      writeFileSync(join(dist, 'client', out), text)
      file.set(src, `client/${out}`)
    }
    if (!isModule(src)) continue
    const mod = join(stage, `map${i}.mjs`)
    writeFileSync(mod, js.get(i) ?? 'export default {}')
    const map = { ...((await import(mod)).default as Record<string, string>) }
    // R19.4: every class the map hands out exists in the CSS it ships with.
    const have = new Set([...(text ?? '').matchAll(CLASS)].map((x) => x[1]!))
    for (const [k, v] of Object.entries(map))
      for (const cls of v.split(/\s+/).filter(Boolean))
        if (!have.has(cls)) throw new BuildError('css', `${src}: class ${k} maps to ${cls}, which is not in the emitted CSS`)
    maps.set(src, map)
  }
  return { file, maps }
}

// ---- Tailwind CSS v4 (gaps round L21, R21.1) ----

/** A stylesheet that needs the Tailwind compiler. */
const TAILWIND_USE = /@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[^"']*)?["']|@apply\b|@reference\b|@theme\b|@plugin\b/
const TAILWIND_IMPORT = /@import\s+(?:url\(\s*)?["']tailwindcss["']/
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["'](\.{1,2}\/[^"']+)["']/g

/** Which sources (or the relative `@import`s they pull in) use Tailwind, and which `@import "tailwindcss"`. */
export function tailwindUse(sources: string[]): { using: string[]; imports: string[] } {
  const using: string[] = []
  const imports: string[] = []
  const seen = new Set<string>()
  const visit = (f: string) => {
    if (seen.has(f)) return
    seen.add(f)
    let text = ''
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      return
    }
    if (TAILWIND_USE.test(text)) using.push(f)
    if (TAILWIND_IMPORT.test(text)) imports.push(f)
    for (const m of text.matchAll(CSS_IMPORT)) visit(resolve(dirname(f), m[1]!))
  }
  for (const s of sources) visit(s)
  return { using, imports }
}

/** R19.4: the one CSS plugin of every JS build. A `.module.css` import is its class map
 * (`export default Object.freeze({…})`); any other `.css` import is an empty module, because the
 * stylesheet itself is linked by the server (R19.3), never bundled into JS. */
export function cssPlugin(maps: Map<string, Record<string, string>>): BunPlugin {
  return {
    name: 'brust-css',
    setup(b) {
      b.onLoad({ filter: /\.css$/ }, (a) => {
        if (!isModule(a.path)) return { contents: '', loader: 'js' }
        const map = maps.get(real(a.path))
        if (!map) throw new Error(`${a.path} is imported by code the build did not reach from a route; import it from a route's component files`)
        return { contents: `export default Object.freeze(${JSON.stringify(map)})\n`, loader: 'js' }
      })
    },
  }
}

/** Direct `.css` imports of `file` (the route entry: linked to no route, so the build warns). */
export function directCss(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const t = new Bun.Transpiler({ loader: file.endsWith('.tsx') ? 'tsx' : 'ts' })
  return t
    .scanImports(src)
    .filter((i) => i.kind === 'import-statement' && i.path.endsWith('.css'))
    .map((i) => i.path)
}
