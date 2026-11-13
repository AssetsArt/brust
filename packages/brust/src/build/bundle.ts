// Bundles of `brust build` (plan T6, spec S5 step 3): the client runtime, native/static component
// chunks (modules they share split into common chunks), one react island chunk per react-tier
// component (shared React split out), and the server-side jobs module. Every staged artifact's
// relative imports resolve against its component's SOURCE directory through `sourceDirPlugin`;
// nothing is copied next to generated files. Every browser build refuses server-only code
// (`serverOnlyPlugin`) and resolves `@brust/core` to its browser-safe entry. Browser outputs are
// renamed to `<stem>-<sha256 hex10>.js` so the server serves them `immutable` (`pipeline.rs`
// `is_hashed` wants lowercase hex; Bun's `[hash]` is base36).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { escapes, inServerOnlyPrefix, posixOf, relPosix } from './posix'
import type { BunPlugin } from 'bun'
import type { Compiled } from './compile'
import { cssPlugin } from './css'
import { BuildError } from './errors'
import { type ExposedModule, wrapperSource } from './expose'
import { isServerOnlyMarker, serverOnlyEmptyPlugin } from './server-only'
import { RUNTIME_FEATURES } from './features'
import { RELATIVE_SPEC, type ResolveTarget, resolveNative } from './esm-resolve'
import { packageDirOf } from './pkg-src'
import { BUILTIN_STORE_MODULES } from '../store/builtin'

const REACT_EXTERNALS = ['react', 'react/*', 'react-dom', 'react-dom/*']
/** Production React (and the production JSX transform: `react/jsx-runtime`, never `jsxDEV`). `brust dev` builds set
 * `BRUST_BUILD_MODE=development` for readable errors and hydration diffs (R13.4); `brust build` never does. */
export const PRODUCTION: Record<string, string> = { 'process.env.NODE_ENV': JSON.stringify(process.env.BRUST_BUILD_MODE === 'development' ? 'development' : 'production'), __BRUST_DEV__: 'false' }

/** `brust build --dev` (L14, R14.3): the client runtime exposes its live instances on a dev global. `__BRUST_DEV__` is a
 * define, `false` in every other build, so the minifier removes the dev code from production bundles. */
export function setDevBuild(dev: boolean): void {
  PRODUCTION.__BRUST_DEV__ = dev ? 'true' : 'false'
}

const matchesExternal = (spec: string, external: string[]) =>
  // A trailing `*` is a prefix (`elysia/*`, `node:*`, `cloudflare:*`): the generated CF entry imports `cloudflare:workers`.
  external.some((p) => (p.endsWith('*') ? spec.startsWith(p.slice(0, -1)) : spec === p))

/** Staged artifact (by its absolute and its real path) → the component SOURCE file it was
 * generated from. */
export type SourceOf = Map<string, string>

/** What every browser build needs to know about the app. */
export interface BrowserCtx {
  sourceOf: SourceOf
  appRoot: string
  /** `brust.toml` `[build] server_only`: import prefixes / app-root-relative paths. */
  serverOnly: string[]
  /** Real paths of server-only files (the actions entry, R8): a browser import of one is refused. */
  serverFiles?: string[]
  /** L19: CSS Module class maps for `cssPlugin` (absent: no CSS was built). */
  cssMaps?: Map<string, Record<string, string>>
  /** F411: `<dist>/client`, where an imported asset is written (see `cssPlugin`). */
  clientDir?: string
  /** F480: load-time writers shipped into an island chunk (F230), by real path: why each is there. A server-only import
   * reached through one names that chain in `server-only-in-client`. */
  loadWriters?: Map<string, LoadWriter>
  /** F495 `[server] base_path`: every `/_brust/…` URL a bundle names carries it (`/portal/_brust/…`); absent or `''` = the root. */
  basePath?: string
}

/** F480/F481: a load writer shipped into island chunks (F230): its path, every island whose chunk carries it, and the modules it is judged to write. */
export interface LoadWriter {
  rel: string
  islands: string[]
  writes: string[]
}

/** F481: `a, b, c and 2 more`: at most `cap` names, in sorted order, then the rest as a count. */
export function namedCapped(names: Iterable<string>, cap = 3): string {
  const all = [...new Set(names)].sort()
  return all.length <= cap ? all.join(', ') : `${all.slice(0, cap).join(', ')} and ${all.length - cap} more`
}

/** The sentence a server-only refusal carries for the load writers it reached: every writer and every island, capped. */
export function loadWriterReason(writers: LoadWriter[]): string {
  const one = (w: LoadWriter) => `${w.rel} is loaded into the React ${w.islands.length > 1 ? 'islands' : 'island'} ${namedCapped(w.islands)} because it is judged to write ${namedCapped(w.writes, 99)} when it loads: F230 load writes`
  const sorted = [...writers].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const shown = sorted.slice(0, 3).map(one).join('; ')
  return sorted.length > 3 ? `${shown}; and ${sorted.length - 3} more load writers` : shown
}

/** F495: brust's own URL prefix for a build, `/_brust` or `<base>/_brust`. */
export const brustRoot = (ctx: { basePath?: string }): string => `${ctx.basePath ?? ''}/_brust`

/** `file` sits under `root`. */
const inside = (root: string, file: string): boolean => file === root || file.startsWith(root.endsWith(sep) ? root : root + sep)

/** The package a bare specifier names is installed in a `node_modules` above `from` (node's own lookup). */
function visibleFrom(spec: string, from: string): boolean {
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', name, 'package.json'))) return true
    if (dirname(d) === d) return false
  }
}

/** Resolution for staged artifacts (`importer` = a staged file registered in `sourceOf`): relative
 * imports mean the component's SOURCE directory; bare imports (`react`, `react-dom/client`, npm
 * packages) resolve from `appRoot`, never from wherever `dist/` sits (an `--out-dir` outside the
 * app has no `node_modules` above it). `external` specifiers are left to Bun so they stay
 * external. `target`: the bundler target a package's own imports resolve for (F189). */
export function sourceDirPlugin(sourceOf: SourceOf, appRoot: string, external: string[] = [], target: ResolveTarget = 'bun', conditions?: string[]): BunPlugin {
  // What the probe must share with the build it stands in for: target, define, conditions (F223); it runs from the app root (F221).
  const probe = { appRoot, conditions }
  return {
    name: 'brust-source-dir',
    setup(b) {
      // `.` and `..` name a directory like `./x` does (F218): one filter, so none of them reaches a package branch.
      b.onResolve({ filter: RELATIVE_SPEC }, (a) => {
        const src = sourceOf.get(a.importer)
        return src === undefined ? undefined : { path: Bun.resolveSync(a.path, dirname(src)) }
      })
      b.onResolve({ filter: /^[^./]/ }, (a) => {
        // A package source imported as itself (a React component revived from it): its bare imports are the package's.
        const own = sourceOf.has(a.importer) ? undefined : packageDirOf(a.importer)
        if (own !== undefined && !matchesExternal(a.path, external)) return { path: resolveNative(a.path, own, target, PRODUCTION, probe) }
        if (!sourceOf.has(a.importer) || matchesExternal(a.path, external)) return undefined
        // F153c: an artifact compiled from a package's source imports what that package sees.
        const pkg = packageDirOf(sourceOf.get(a.importer)!)
        if (pkg !== undefined) return { path: resolveNative(a.path, pkg, target, PRODUCTION, probe) }
        // A package the staged file can see from where it sits resolves natively: the bundler then picks the package's ESM
        // entry (`module` / `exports.import`) and tree-shakes it. `Bun.resolveSync` answers with the CJS `main`, which
        // bundles the whole package (recharts: +85 KB gzip on the chart page). Packages only the app root sees (a staged
        // file under `dist/`, an `--out-dir` outside the app) keep the pinned resolution, so one copy of each package.
        if (inside(appRoot, a.importer) && visibleFrom(a.path, dirname(a.importer))) return undefined
        return { path: Bun.resolveSync(a.path, appRoot) }
      })
    },
  }
}

const BUILTINS = new Set(builtinModules)
/** The browser-safe entry of this package (`exports["."].browser`). */
const BROWSER_ENTRY = resolve(import.meta.dir, '../browser.ts')
const SERVER_ONLY_NS = 'brust-server-only'

/** An npm package `name` is installed in a `node_modules` above `from` (or above `appRoot`). */
function installed(name: string, from: string, appRoot: string): boolean {
  for (const start of [from, appRoot])
    for (let d = start; ; d = dirname(d)) {
      if (existsSync(join(d, 'node_modules', name, 'package.json'))) return true
      if (dirname(d) === d) break
    }
  return false
}

/** Builtin names whose npm package of the same name is a real browser polyfill (the browserify
 * set: `events`, `buffer`, `util`, …). Only these are let through when the app installed them; an
 * npm package named `fs`, `child_process`, `net`, `tls`, `dns`, `crypto`, `http(s)`, `os`,
 * `worker_threads`, `cluster`, `module`, `vm`, `v8`, … never unlocks the builtin. */
const BROWSER_POLYFILLS = new Set([
  'assert',
  'buffer',
  'events',
  'path',
  'process',
  'punycode',
  'querystring',
  'stream',
  'string_decoder',
  'timers',
  'url',
  'util',
])

/** `spec` (imported by `importer`) may not enter a browser bundle. Server-only (spec §8.2 +
 * m2c): a Node/Bun builtin (`node:*`, `bun:*`, `bun`, a bare builtin name such as `fs` or
 * `fs/promises` — unless it is an allowlisted browser polyfill the app installed), the server
 * parts of this package, a `*.server.*` file, or a prefix / app-root relative path listed in
 * `[build] server_only`. M3-F R8 adds three: `@brust/core/elysia`, `elysia` (and `elysia/*`), and
 * the configured actions entry file (`ctx.serverFiles`, compared by real path). A bare specifier is
 * matched against `server_only` as written (an entry can name a package), and EVERY specifier is
 * also checked by the file it resolves to (Bun's resolver honours tsconfig `paths`, so an alias
 * cannot bypass the `*.server.*` / path rules). */
function isServerOnly(spec: string, importer: string, ctx: BrowserCtx): boolean {
  if (isServerOnlyMarker(spec)) return true // `import 'server-only'`: the marker never reaches a browser bundle, whether or not the package throws
  if (spec.startsWith('node:') || spec.startsWith('bun:') || spec === 'bun') return true
  const from = dirname(ctx.sourceOf.get(importer) ?? importer)
  const bare = spec.split('/')[0]!
  if ((BUILTINS.has(spec) || BUILTINS.has(bare)) && !(BROWSER_POLYFILLS.has(bare) && installed(bare, from, ctx.appRoot))) return true
  if (/^@brust\/core\/(server|native|compile|elysia)(\/|$)/.test(spec)) return true
  if (spec === 'elysia' || spec.startsWith('elysia/')) return true
  if (/\.server(\.[^/]*)?$/.test(spec)) return true
  const isPath = spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec)
  if (!isPath && ctx.serverOnly.some((p) => spec.startsWith(p))) return true
  let file: string
  try {
    file = isAbsolute(spec) ? spec : Bun.resolveSync(spec, from)
  } catch {
    return false // unresolvable: Bun reports it
  }
  if (/\.server\.[^/]*$/.test(basename(file))) return true
  // Any other name (an alias, a relative path) that resolves INTO the `server-only` package is the marker too.
  try {
    if (/[\\/]node_modules[\\/]server-only[\\/]/.test(realpathSync(file))) return true
  } catch {}
  try {
    if (ctx.serverFiles?.includes(realpathSync(file))) return true
  } catch {}
  return inServerOnlyPrefix(relative(ctx.appRoot, file), ctx.serverOnly)
}

/** Fails a browser build that would include server-only code at any depth (a client chunk, an
 * island, or any module either reaches), and points `@brust/core` at its browser-safe entry. An
 * offending import is stubbed so the bundler gets as far as it can; `browserBuild` then throws
 * `server-only-in-client` naming every `<importer> imports <spec>`. */
function serverOnlyPlugin(ctx: BrowserCtx, violations: string[]): BunPlugin {
  const writers = ctx.loadWriters ?? new Map<string, LoadWriter>()
  // F480/F481: who imports each file (real paths; every importer, not the first), kept only while a load writer ships, to name the writer chain.
  const importersOf = new Map<string, Set<string>>()
  const real = (f: string) => {
    try {
      return realpathSync(f)
    } catch {
      return f
    }
  }
  const noteImport = (spec: string, importer: string) => {
    const from = real(ctx.sourceOf.get(importer) ?? importer)
    try {
      const file = real(isAbsolute(spec) ? spec : Bun.resolveSync(spec, dirname(from)))
      let set = importersOf.get(file)
      if (!set) importersOf.set(file, (set = new Set()))
      set.add(from)
    } catch {}
  }
  /** Every load writer a module is reached through (a walk up all its importers, stopping at a writer), as the refusal's reason. */
  const writerChain = (importer: string): string => {
    const seen = new Set<string>()
    const found: LoadWriter[] = []
    const stack = [real(ctx.sourceOf.get(importer) ?? importer)]
    while (stack.length > 0) {
      const f = stack.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      const w = writers.get(f)
      if (w !== undefined) {
        found.push(w)
        continue
      }
      stack.push(...(importersOf.get(f) ?? []))
    }
    return found.length > 0 ? ` (${loadWriterReason(found)})` : ''
  }
  return {
    name: 'brust-server-only',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (!a.importer || a.path.startsWith(`${brustRoot(ctx)}/`)) return undefined
        if (a.path === '@brust/core') return { path: BROWSER_ENTRY }
        if (!isServerOnly(a.path, a.importer, ctx)) {
          if (writers.size > 0) noteImport(a.path, a.importer)
          return undefined
        }
        const msg = `${relPosix(ctx.appRoot, ctx.sourceOf.get(a.importer) ?? a.importer)} imports ${a.path}${writerChain(a.importer)}`
        if (!violations.includes(msg)) violations.push(msg)
        return { path: a.path, namespace: SERVER_ONLY_NS }
      })
      b.onLoad({ filter: /.*/, namespace: SERVER_ONLY_NS }, () => ({ contents: 'export default {}', loader: 'js' }))
    },
  }
}

const hex = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10)
/** `f` resolved (from the working directory) and with symlinks followed, as the bundler names a module. */
const realPath = (f: string): string => {
  try {
    return realpathSync(f)
  } catch {
    return resolve(f)
  }
}

export const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Runs one browser `Bun.build` in memory (server-only guard first), renames every output
 * `<stem>-<bunhash>.js` to `<stem>-<hex10>.js` (rewriting cross-chunk imports), writes them into
 * `dist/client/` and returns entry stem → `client/<file>`. */
async function browserBuild(
  dist: string,
  what: string,
  ctx: BrowserCtx,
  config: Omit<Parameters<typeof Bun.build>[0], 'outdir' | 'target' | 'format' | 'naming'> & { splitting?: boolean },
  /** F549: given, the build also reports the real path of every module it bundled (the metafile's inputs). */
  inputs?: Set<string>,
): Promise<Map<string, string>> {
  const violations: string[] = []
  const fail = () => new BuildError('server-only-in-client', `${what}: ${violations.join('; ')} (server-only code in a browser bundle)`)
  let res: Awaited<ReturnType<typeof Bun.build>>
  try {
    res = await Bun.build({
      ...config,
      ...(inputs ? { metafile: true } : {}),
      plugins: [serverOnlyPlugin(ctx, violations), cssPlugin(ctx.cssMaps ?? new Map(), ctx.clientDir, ctx.basePath), ...(config.plugins ?? [])],
      target: 'browser',
      format: 'esm',
      minify: true,
      define: PRODUCTION,
      naming: { entry: '[name]-[hash].[ext]', chunk: 'chunk-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    })
  } catch (e) {
    // A stubbed server-only import usually breaks the bundle (missing named export): report the cause.
    if (violations.length > 0) throw fail()
    throw e
  }
  if (violations.length > 0) throw fail()
  if (!res.success) throw new BuildError('bundle', `${what}: ${res.logs.map(String).join('\n')}`)
  if (inputs && res.metafile) for (const k of Object.keys(res.metafile.inputs)) inputs.add(realPath(k))
  const outs = await Promise.all(res.outputs.map(async (o) => ({ o, name: basename(o.path), text: await o.text() })))
  const rename = new Map<string, string>()
  for (const { name, text } of outs) {
    const m = /^(.*)-[^-]+\.js$/.exec(name)
    if (!m) throw new BuildError('bundle', `${what}: unexpected output ${name}`)
    rename.set(name, `${m[1]}-${hex(text)}.js`)
  }
  const entries = new Map<string, string>()
  for (const { o, name, text } of outs) {
    let body = text
    for (const [from, to] of rename) if (from !== name) body = body.split(from).join(to)
    const file = rename.get(name)!
    write(join(dist, 'client', file), body)
    if (o.kind === 'entry-point') entries.set(/^(.*)-[^-]+\.js$/.exec(name)![1]!, `client/${file}`)
  }
  return entries
}

/** The client runtime's URLs (L33): the core every page loads, the `store` module (`defineStore` + the reactive
 * primitives a store's code imports), and the feature modules. Core and features are single shared ESM files, so a
 * page has one signal graph and one binder registry however many features it loads. */
export interface RuntimeUrls {
  core: string
  store: string
}

/** D3/C6: one runtime instance per page. Island and native client builds resolve the reactive core to the core URL
 * and the store API to the store module's URL (external), exactly as the compiler's `runtimeImport` (the core). The
 * React bridge (`useStore`) is bundled (it holds no module state), but ITS imports of the core are the store
 * module too. Registered after `serverOnlyPlugin`, before `sourceDirPlugin` (which would resolve the
 * bare specifiers to files). */
export function runtimeAliasPlugin(urls: RuntimeUrls): BunPlugin {
  return {
    name: 'brust-runtime-alias',
    setup(b) {
      b.onResolve({ filter: /^@brust\/runtime-dom(\/core)?$/ }, () => ({ path: urls.core, external: true }))
      b.onResolve({ filter: /^@brust\/(runtime-dom|core)\/store$/ }, () => ({ path: urls.store, external: true }))
      let bridge: string | undefined
      b.onResolve({ filter: /^@brust\/(runtime-dom|core)\/store\/react$/ }, () => {
        bridge ??= Bun.resolveSync('@brust/runtime-dom/store/react', import.meta.dir) // core lane file; resolved lazily
        return { path: bridge }
      })
      b.onResolve({ filter: /^\.\.?\// }, (a) => (bridge !== undefined && a.importer === bridge ? { path: urls.store, external: true } : undefined))
    },
  }
}

/** What `buildRuntime` wrote: `client/<file>` paths (relative to dist). */
export interface RuntimeAssets {
  /** The core: `export *` of the runtime core + `mount(document.documentElement)` (contract 6). */
  core: string
  store: string
  /** Feature module name → file; every module is built, a route links the ones its components need. */
  features: Record<string, string>
  /** F453: the standalone SPA-navigation module (`nav-<hex>.js`); imports nothing from the core, so a page that loads no runtime still has it. */
  nav: string
}

/** `dist/client/runtime-<hex>.js` (the core; client chunks import `signal`, `defineBehavior`, … from this URL), then
 * one `rt-<feature>-<hex>.js` per feature module and `rt-store-<hex>.js`, each importing the core by that URL. */
export async function buildRuntime(dist: string, ctx: BrowserCtx): Promise<RuntimeAssets> {
  // Resolved from this package (its dependency), not from wherever `dist/` sits.
  const dir = dirname(Bun.resolveSync('@brust/runtime-dom', import.meta.dir))
  const coreEntry = join(dist, '.stage', 'runtime.ts')
  write(coreEntry, "export * from '@brust/runtime-dom/core'\nimport { mount } from '@brust/runtime-dom/core'\nmount(document.documentElement)\n")
  const core = (
    await browserBuild(dist, 'runtime', ctx, {
      entrypoints: [coreEntry],
      plugins: [{ name: 'brust-runtime-dom', setup: (b) => void b.onResolve({ filter: /^@brust\/runtime-dom\/core$/ }, () => ({ path: join(dir, 'core.ts') })) }],
    })
  ).get('runtime')!
  // Features import the core's API (`core-api`, and `core` for the store's re-exports) from the core file by URL.
  const coreUrl = `${brustRoot(ctx)}/${core}`
  const coreFiles = new Set(['core-api', 'core'].map((f) => join(dir, f)))
  const names = [...RUNTIME_FEATURES, 'store'] as const
  const entries = names.map((n) => {
    const file = join(dist, '.stage', `rt-${n}.ts`)
    write(file, `import ${JSON.stringify(join(dir, 'features', n))}\nexport * from ${JSON.stringify(join(dir, 'features', n))}\n`)
    return file
  })
  // F453: `nav` is its own entry (it imports nothing from the core), named `nav-<hex>.js`.
  const navEntry = join(dist, '.stage', 'nav.ts')
  write(navEntry, `import ${JSON.stringify(join(dir, 'nav', 'index.ts'))}\n`)
  const built = await browserBuild(dist, 'runtime features', ctx, {
    entrypoints: [...entries, navEntry],
    plugins: [
      {
        name: 'brust-runtime-core-external',
        setup: (b) =>
          void b.onResolve({ filter: /^\.\.?\/(core-api|core)$/ }, (a) => (coreFiles.has(resolve(dirname(a.importer), a.path)) ? { path: coreUrl, external: true } : undefined)),
      },
    ],
  })
  const features: Record<string, string> = {}
  for (const n of RUNTIME_FEATURES) features[n] = built.get(`rt-${n}`)!
  return { core, store: built.get('rt-store')!, features, nav: built.get('nav')! }
}

/** F549 `[build] expose_isolated`: an import of an exposed file from app code (a staged component chunk, or a module it
 * pulls in) becomes the URL of that file's own `x-<stem>` entry, external, so the chunk build never sees the module: it
 * is not hoisted into a chunk shared with the exposed entry, and the exposed entry stays the one instance of it. Imports
 * made from inside `node_modules` are left alone (an exposed file is app code). Registered before `sourceDirPlugin`,
 * which would resolve the specifier to the file. */
export function exposedUrlPlugin(urls: ReadonlyMap<string, string>, sourceOf: SourceOf): BunPlugin {
  const NM = `${sep}node_modules${sep}`
  // One answer per (importer directory, specifier): a component's chunk repeats the same imports many times over.
  const memo = new Map<string, string | null>()
  return {
    name: 'brust-exposed-url',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.importer === '' || a.importer.includes(NM)) return undefined
        const dir = dirname(sourceOf.get(a.importer) ?? a.importer)
        const key = `${dir}\0${a.path}`
        let url = memo.get(key)
        if (url === undefined) {
          try {
            url = urls.get(realPath(Bun.resolveSync(a.path, dir))) ?? null
          } catch {
            url = null // a virtual or external specifier: not a file
          }
          memo.set(key, url)
        }
        return url === null ? undefined : { path: url, external: true }
      })
    },
  }
}

/** F549: the modules bundled into BOTH the exposed build and the component build of an isolated build: each a copy in
 * the browser. A path inside `node_modules` is named by its package; a brust package and brust's staged files are not
 * the app's to act on, so they are left out. */
export function duplicatedModules(a: ReadonlySet<string>, b: ReadonlySet<string>, appRoot: string, dist: string): string[] {
  const stage = join(dist, '.stage') + sep
  const names = new Set<string>()
  for (const f of a) {
    if (!b.has(f) || f.startsWith(stage)) continue
    const nm = f.lastIndexOf(`${sep}node_modules${sep}`)
    if (nm >= 0) {
      const parts = f.slice(nm + 14).split(sep)
      const pkg = parts[0]!.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
      if (!pkg.startsWith('@brust/')) names.add(pkg)
    } else if (inside(appRoot, f)) names.add(relPosix(appRoot, f))
    else names.add(f)
  }
  return [...names]
}

/** One entry chunk per component with client JS (`<id>-<hex>.js`), split: a module two chunks
 * import (a store) lands once in a shared `chunk-<hex>.js`, so one page has one instance of it.
 * The runtime import stays the absolute `/_brust/client/runtime-<hex>.js` URL the compiler
 * printed (external: one runtime for every chunk). */
export async function buildClientChunks(
  dist: string,
  compiled: Map<string, Compiled>,
  ctx: BrowserCtx,
  runtimeUrl: RuntimeUrls,
  /** F517 `[build] expose`: each module is one more entry of this build, so a chunk that imports it and the entry's URL are one module instance. */
  exposed: ExposedModule[] = [],
  /** F549 `[build] expose_isolated`: the exposed modules are built first, in a bundle of their own, and the component chunks import them by URL instead of sharing a chunk with them. */
  isolated = false,
  /** Build warnings (`[brust] warning …`). */
  log: (line: string) => void = () => {},
): Promise<{ chunks: Map<string, string>; exposed: Record<string, string> }> {
  const entrypoints: string[] = []
  const shared = new Map<string, string>()
  // F362 PR2: a chunk that declares an imported list projected keeps it only while its data module is out of the client
  // graph: another importer (a module that pushes into the list) would hold the real one, which the copy never sees.
  const whole = await projectionFallbacks(dist, compiled, ctx, runtimeUrl, exposed)
  for (const c of compiled.values()) {
    if (c.clientJs === undefined) continue
    const file = join(dist, '.stage', 'client', `${c.id}.js`)
    write(file, whole.has(c.id) ? c.clientJsWhole! : c.clientJs)
    // R34.124: a module several chunks import (a specialised clone's factory) is written once under its content name.
    for (const m of c.clientModules ?? []) {
      const mf = join(dist, '.stage', 'client', `${m.name}.js`)
      const seen = shared.get(m.name)
      if (seen !== undefined && seen !== m.code) throw new BuildError('client-module-collision', `two different client modules are named ${m.name}`)
      if (seen === undefined) {
        shared.set(m.name, m.code)
        write(mf, m.code)
        stage(ctx.sourceOf, mf, c)
      }
    }
    stage(ctx.sourceOf, file, c)
    entrypoints.push(file)
  }
  // `x-<stem>.js` re-exports the module under its own names; the bundler puts the module itself in a chunk the component
  // chunks import too (one instance), and names the entry `x-<stem>-<hex10>.js`.
  const stageDir = join(dist, '.stage', 'client')
  const wrappers = exposed.map((m) => {
    const file = join(stageDir, `x-${m.stem}.js`)
    write(file, wrapperSource(m))
    return file
  })
  const files: Record<string, string> = {}
  const urls = new Map<string, string>()
  const plugins = [runtimeAliasPlugin(runtimeUrl), specModulePlugin(stageDir), sourceDirPlugin(ctx.sourceOf, ctx.appRoot, [], 'browser')]
  if (isolated && exposed.length > 0) {
    // F549: the exposed entries are the only entries of their own build (splitting stays inside it), and the component
    // build below treats each of their files as an external URL, so a module both sides import is copied into the
    // component's chunk, not hoisted into a chunk of its own.
    const exposedInputs = new Set<string>()
    const xs = await browserBuild(dist, 'exposed modules', ctx, { entrypoints: wrappers, splitting: true, external: [`${brustRoot(ctx)}/*`], plugins }, exposedInputs)
    for (const m of exposed) {
      const f = xs.get(`x-${m.stem}`)
      if (f === undefined) throw new BuildError('expose', `build.expose ${m.rel}: the bundler wrote no entry for it`)
      files[m.rel] = f
      urls.set(m.abs, `${brustRoot(ctx)}/${f}`)
    }
    if (entrypoints.length === 0) return { chunks: new Map(), exposed: files }
    const chunkInputs = new Set<string>()
    const built = await browserBuild(
      dist,
      'client chunks',
      ctx,
      { entrypoints, splitting: true, external: [`${brustRoot(ctx)}/*`], plugins: [exposedUrlPlugin(urls, ctx.sourceOf), ...plugins] },
      chunkInputs,
    )
    const twice = duplicatedModules(exposedInputs, chunkInputs, ctx.appRoot, dist)
    if (twice.length > 0)
      log(`[brust] warning expose-isolated-duplicate ${namedCapped(twice, 8)}: bundled into both the exposed modules and the component chunks, so the page holds two copies of ${twice.length > 1 ? 'each' : 'it'}. A module holding state (a store, a cache, a singleton) must be reached through an exposed module, or be exposed itself`)
    return { chunks: built, exposed: files }
  }
  entrypoints.push(...wrappers)
  if (entrypoints.length === 0) return { chunks: new Map(), exposed: {} }
  const built = await browserBuild(dist, 'client chunks', ctx, { entrypoints, splitting: true, external: [`${brustRoot(ctx)}/*`], plugins })
  for (const m of exposed) {
    const f = built.get(`x-${m.stem}`)
    if (f === undefined) throw new BuildError('expose', `build.expose ${m.rel}: the bundler wrote no entry for it`)
    files[m.rel] = f
    built.delete(`x-${m.stem}`)
  }
  return { chunks: built, exposed: files }
}

/** F362 PR2: the ids of the chunks that must import their lists as written. A probe build (metafile only, nothing
 * written to `client/`) lists every module the client graph loads; a chunk whose projected data module is among them
 * falls back to `clientJsWhole`, which brings that module in, so the probe repeats until no projected module is in the
 * graph. Without a projected chunk nothing is probed. */
export async function projectionFallbacks(dist: string, compiled: Map<string, Compiled>, ctx: BrowserCtx, runtimeUrl: RuntimeUrls, exposed: ExposedModule[] = []): Promise<Set<string>> {
  const whole = new Set<string>()
  const projecting = [...compiled.values()].filter((c) => c.clientJs !== undefined && c.projectedModules?.length && c.clientJsWhole !== undefined)
  if (projecting.length === 0) return whole
  const real = (f: string) => {
    try {
      return realpathSync(f)
    } catch {
      return resolve(f)
    }
  }
  const probeDir = join(dist, '.stage', 'probe')
  for (;;) {
    const entrypoints: string[] = []
    for (const c of compiled.values()) {
      if (c.clientJs === undefined) continue
      const file = join(probeDir, `${c.id}.js`)
      write(file, whole.has(c.id) ? c.clientJsWhole! : c.clientJs)
      for (const m of c.clientModules ?? []) {
        const mf = join(probeDir, `${m.name}.js`)
        write(mf, m.code)
        stage(ctx.sourceOf, mf, c)
      }
      stage(ctx.sourceOf, file, c)
      entrypoints.push(file)
    }
    // An exposed module is part of the client graph too: a projected data module it imports is loaded for real.
    for (const m of exposed) {
      const file = join(probeDir, `x-${m.stem}.js`)
      write(file, wrapperSource(m))
      entrypoints.push(file)
    }
    const res = await Bun.build({
      entrypoints,
      splitting: true,
      external: [`${brustRoot(ctx)}/*`],
      target: 'browser',
      format: 'esm',
      metafile: true,
      plugins: [serverOnlyPlugin(ctx, []), cssPlugin(ctx.cssMaps ?? new Map(), ctx.clientDir, ctx.basePath), runtimeAliasPlugin(runtimeUrl), specModulePlugin(probeDir), sourceDirPlugin(ctx.sourceOf, ctx.appRoot, [], 'browser')],
    })
    if (!res.success || !res.metafile) throw new BuildError('bundle', `client chunks (projection probe): ${res.logs.map(String).join('\n')}`)
    const loaded = new Set(Object.keys(res.metafile.inputs).map((k) => real(resolve(k))))
    const next = projecting.filter((c) => !whole.has(c.id) && c.projectedModules!.some((m) => loaded.has(real(join(ctx.appRoot, m)))))
    if (next.length === 0) return whole
    for (const c of next) whole.add(c.id)
  }
}

/** R34.124: `brust-spec:<name>` is a module several chunks share (a specialised clone's factory), written beside the chunks. */
function specModulePlugin(dir: string): BunPlugin {
  return {
    name: 'brust-spec-modules',
    setup: (b) => void b.onResolve({ filter: /^brust-spec:/ }, (a) => ({ path: join(dir, `${a.path.slice('brust-spec:'.length)}.js`) })),
  }
}

/** Registers a written artifact (by its path and its real path: the importer Bun reports). */
export function stage(sourceOf: SourceOf, file: string, c: Compiled): void {
  sourceOf.set(file, c.file)
  sourceOf.set(realpathSync(file), c.file)
}

const isReact = (c: Compiled) => typeof c.ir.tier === 'object' && c.ir.tier !== null && 'React' in c.ir.tier

/** An import/export binding spelled as the module wrote it: bare when an identifier, else a string name. */
const bindingName = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name))

/** The `import` line that brings a react-tier component's code in as `local`: the binding its importer used
 * (`import Foo` → the default export, `import { Foo }` / `export { A as Foo }` / `export const Foo` → `Foo`),
 * or for a package export (L22) the export itself. Each component of a file with several is its own island
 * entry; the bundler keeps ONE instance of the file for all of them (splitting). */
export function componentImport(c: Compiled, local: string): string {
  // F188 (R34.62): a component compiled from a package source is imported as the package's own export, so the island
  // and every revived component share the dist's one module instance (a `createContext` among them).
  const ext = c.ir.external ?? c.ir.dist
  if (ext?.member?.length) return memberImport(ext as { source: string; export: string; member: string[] }, local)
  const [from, binding] = ext ? [JSON.stringify(ext.source), ext.export] : [JSON.stringify(c.file), c.ir.export ?? 'default']
  return binding === 'default' ? `import ${local} from ${from}` : `import { ${bindingName(binding)} as ${local} } from ${from}`
}

/** A member of a package import (`<DialogPrimitive.Root>`, S1.4 R34.35): the export (a name, `default`, or `*` for a
 * namespace import) is bound once and the member is read off it. A path the package does not have is `undefined`
 * (the bundler does not check member access), so it throws a named error when the island entry or the SSR job loads. */
function memberImport(ext: { source: string; export: string; member: string[] }, local: string): string {
  const ns = `${local}__ns`
  const from = JSON.stringify(ext.source)
  const head = ext.export === 'default' ? `import ${ns} from ${from}` : ext.export === '*' ? `import * as ${ns} from ${from}` : `import { ${bindingName(ext.export)} as ${ns} } from ${from}`
  const path = (ext.export === '*' ? ext.member : [ext.export, ...ext.member]).join('.')
  const read = ext.member.map((m) => (/^[A-Za-z_$][\w$]*$/.test(m) ? `.${m}` : `[${JSON.stringify(m)}]`)).join('')
  return `${head}\nconst ${local} = ${ns}${read}\nif (${local} === undefined) throw new Error(${JSON.stringify(`brust: ${ext.source} has no export ${path}`)})`
}

/** The component ids a React island receives inside its lowered JSX children (shadcn S1, R34.21): the union over
 * every file that passes children to it. `undefined` = no file does, the island has no revive code. */
export function nestedOf(compiled: Map<string, Compiled>, id: string, routeRoots?: ReadonlySet<string>): string[] | undefined {
  // F158 (R34.70): a route component's props are request data, so it is never a revive host, whatever a caller did.
  if (routeRoots?.has(id)) return undefined
  let out: Set<string> | undefined
  for (const c of compiled.values()) {
    for (const ref of c.ir.children ?? []) {
      // `nested: []` (element-only children) still makes the island a host: its children are a JSON tree to revive.
      if (ref.id === id && ref.nested !== undefined) {
        out ??= new Set()
        for (const n of ref.nested) out.add(n)
      }
    }
  }
  // F148a (R34.121): a wrapper whose island renders `{children}` (a `$c` hole) is handed a tree by each call site; the
  // components those trees name are revived by the island inside the wrapper, so its chunk and job import them.
  for (const w of compiled.values()) {
    if (!(w.ir.children ?? []).some((r) => r.id === id && (r.holes ?? []).some((h) => h.startsWith('$c')))) continue
    for (const c of compiled.values()) {
      for (const ref of c.ir.children ?? []) {
        if (ref.id === w.id && ref.nested) {
          out ??= new Set()
          for (const n of ref.nested) out.add(n)
        }
      }
    }
  }
  return out && [...out].sort()
}

/** F148a (R34.120): the island props the compiler wrote for the values its children read from props (`$p<N>`: a
 * primitive, `$c<N>`: a tree a wrapper's call site bound), at any call site of the island `id`. The only `$` keys,
 * besides `$x`, its revive accepts. */
export function holesOf(compiled: Map<string, Compiled>, id: string): string[] {
  const out = new Set<string>()
  for (const c of compiled.values()) for (const ref of c.ir.children ?? []) if (ref.id === id) for (const k of ref.holes ?? []) out.add(k)
  return [...out].sort()
}

/** F158 (R34.71): the element-prop names (`$x`) the compiler wrote at any call site of the island `id`: the only names
 * its revive may revive. */
export function xOf(compiled: Map<string, Compiled>, id: string): string[] {
  const out = new Set<string>()
  for (const c of compiled.values()) for (const ref of c.ir.children ?? []) if (ref.id === id) for (const k of ref.x ?? []) out.add(k)
  return [...out].sort()
}

/** Every component some island revives (`nestedOf`), whatever its tier: its module must export it. */
function revivedIds(compiled: Map<string, Compiled>): Set<string> {
  const out = new Set<string>()
  for (const c of compiled.values()) for (const ref of c.ir.children ?? []) for (const n of ref.nested ?? []) out.add(n)
  return out
}

/** The code that turns an island's `children` prop (a JSON tree the compiler lowered, `{ $brust: 'el' | 'fr' | 'cmp' }`)
 * back into React elements. One copy per entry that needs it, shared by the island chunk and the SSR job so both sides
 * build the same tree. `reg` maps a component id to the component. */
export const reviveSource = (reg: string): string =>
  `const __reg: Record<string, any> = Object.assign(Object.create(null), ${reg})\n` +
  `const __own = Object.prototype.hasOwnProperty\n` +
  // The tree is compiler output, but props travel in page markup: read it as untrusted. A tag must be a plain element
  // name, a component must be in this island's registry (own keys only), and the raw-HTML prop is never revived.
  // `hv` holds the island's hole values (F148a, R34.116): the props the compiler declared (`$p<N>` primitives, `$c<N>`
  // trees). A value node reads one and renders it only when it is a string or a finite number (an attribute: also a boolean; text: also an array of them);
  // anything else renders nothing, and is never walked, so request data can fill a leaf but never shape the tree.
  `const __hole = (hv: any, k: any): any => hv == null || typeof k !== 'string' || !/^[$]p[0-9]+$/.test(k) || !__own.call(hv, k) ? undefined : hv[k]\n` +
  `const __prim = (hv: any, k: any, bool: boolean): any => { const x = __hole(hv, k); return typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)) || (bool && typeof x === 'boolean') ? x : undefined }\n` +
  `const __props = (p: any, hv: any): any => { const o: any = {}; if (p && typeof p === 'object') for (const k of Object.keys(p)) if (k !== '__proto__' && k !== 'dangerouslySetInnerHTML' && k !== 'children' && k !== 'ref' && k !== 'key') { const v = p[k]; if (v !== null && typeof v === 'object' && v.$brust === 'v') { const x = __prim(hv, v.k, true); if (x !== undefined) o[k] = x } else o[k] = v } return o }\n` +
  // `x` (on a component node) and `$x` (on the island's props) are the compiler's list of props that hold an element
  // tree. Only those names are revived, and only when the prop is an own key of the copy; data is never revived.
  `const __xs = (o: any, x: any, hv: any): any => { if (Array.isArray(x)) for (const k of x) if (typeof k === 'string' && k.charAt(0) !== '$' && __own.call(o, k)) o[k] = __rv(o[k], hv); return o }\n` +
  `const __kids = (c: any, hv: any): any[] => Array.isArray(c) ? c.map((k: any) => __rv(k, hv)) : []\n` +
  `const __rv = (n: any, hv: any): any => {\n` +
  `  if (n === null || typeof n !== 'object') return n\n` +
  // A text leaf is a string or a finite number; an array of them (React renders each) keeps those items. Anything else
  // renders nothing and is never walked.
  `  if (n.$brust === 'v') { const x = __hole(hv, n.k); if (Array.isArray(x)) return createElement(Fragment, null, ...x.filter((e: any) => typeof e === 'string' || (typeof e === 'number' && Number.isFinite(e)))); const p = __prim(hv, n.k, false); return p === undefined ? null : p }\n` +
  // A condition is the truthiness of the declared own hole, as in React, without reading into the value. `a` is the
  // `cond && <X/>` form: React renders a falsy number there (0) as text.
  `  if (n.$brust === 'if') { const x = __hole(hv, n.k); return createElement(Fragment, null, ...(!x && n.a === true && typeof x === 'number' ? [x] : __kids(x ? n.c : n.e, hv))) }\n` +
  // The caller's tree: compile-time, bound by the wrapper's call site. It holds no hole of its own, so it is revived
  // with none (a tree that named one would render nothing, and cannot recurse).
  `  if (n.$brust === 'slot') return typeof n.k === 'string' && /^[$]c[0-9]+$/.test(n.k) && hv != null && __own.call(hv, n.k) ? __rv(hv[n.k], null) : null\n` +
  `  const kids = __kids(n.c, hv)\n` +
  `  if (n.$brust === 'fr') return createElement(Fragment, null, ...kids)\n` +
  `  if (n.$brust === 'el') { if (typeof n.t !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(n.t)) throw new Error('brust: island children hold an invalid element name'); return createElement(n.t, __props(n.p, hv), ...kids) }\n` +
  `  if (n.$brust === 'cmp') { if (typeof n.id !== 'string' || !__own.call(__reg, n.id)) throw new Error('brust: island children name the component ' + String(n.id) + ', which this island does not import'); return createElement(__reg[n.id], __xs(__props(n.p, hv), n.x, hv), ...kids) }\n` +
  `  throw new Error('brust: island children hold an unknown node')\n` +
  `}\n` +
  // `X` is the host's compiler-declared element-prop names (R34.71): a `$x` from the props can only select among them.
  // `H` is its declared hole names (R34.120). A `$`-key that is neither `$x` nor in `H` is never the compiler's (R34.72):
  // it throws instead of rendering (a 500, not a revive). Hole props are the revive's, not the component's.
  `const __mk = (C: any, props: any, X: string[] = [], H: string[] = []) => {\n` +
  `  for (const k of Object.keys(props)) if (k.charAt(0) === '$' && k !== '$x' && !H.includes(k)) throw new Error('brust: island props hold the reserved key ' + k)\n` +
  `  const { children, $x, ...rest } = props\n` +
  `  const hv: any = Object.create(null)\n` +
  `  for (const k of H) if (__own.call(rest, k)) { hv[k] = rest[k]; delete rest[k] }\n` +
  `  __xs(rest, Array.isArray($x) ? $x.filter((k: any) => X.includes(k)) : undefined, hv)\n` +
  `  return createElement(C, rest, ...(children === undefined ? [] : Array.isArray(children) ? children : [children]).map((k: any) => __rv(k, hv)))\n` +
  `}\n`

/** A helper component its module does not export (`ir.unexported`: `function SheetOverlay() {…}` rendered by an exported
 * `SheetContent`) that still renders as an island has nothing to import: the module is loaded with `export { Name }`
 * appended, for the island chunks and the SSR jobs alike (one module, one instance, either way). */
export function exposePlugin(compiled: Map<string, Compiled>): BunPlugin {
  const names = new Map<string, Set<string>>()
  const revived = revivedIds(compiled)
  for (const c of compiled.values()) {
    if (!(isReact(c) || revived.has(c.id)) || !c.ir.unexported || c.ir.external || !c.ir.export) continue
    for (const f of new Set([c.file, realpathSync(c.file)])) names.set(f, (names.get(f) ?? new Set()).add(c.ir.export))
  }
  return {
    name: 'brust-expose-local-islands',
    setup(b) {
      b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (a) => {
        const exposed = names.get(a.path)
        if (!exposed) return undefined
        const loader = /\.[cm]?ts$/.test(a.path) ? 'ts' : /\.[cm]?js$/.test(a.path) ? 'js' : a.path.endsWith('.jsx') ? 'jsx' : 'tsx'
        return { contents: `${await Bun.file(a.path).text()}\nexport { ${[...exposed].join(', ')} }\n`, loader }
      })
    },
  }
}

/** The island entry of a react-tier component: registers `(host, props, committed) => …` under its id; the hydrate fn returns the root's unmount, which the runtime calls when the host leaves the document (SPA navigation). A
 * `client_only` component was never server-rendered (its host is empty), so it mounts with
 * `createRoot`; hydrating it would fail (React #418). Everything else hydrates the SSR markup. */
/** `writers` (F230): app modules that write another module's exports when they load; imported first, so the island
 * hydrates from what the app's React render saw. */
export function islandShim(c: Compiled, compiled?: Map<string, Compiled>, routeRoots?: ReadonlySet<string>, writers: string[] = []): string {
  const clientOnly = c.ir.tier?.React?.client_only === true
  const nested = compiled && nestedOf(compiled, c.id, routeRoots)
  const element = nested ? `__mk(Comp, props, ${JSON.stringify(xOf(compiled!, c.id))}, ${JSON.stringify(holesOf(compiled!, c.id))})` : 'createElement(Comp, props)'
  // F545: the root renders inside `__Commit`, whose layout effect tells the runtime the tree has committed. A component
  // that returns its one child adds no DOM and no useId fork, so server and client markup stay equal.
  const tree = `createElement(__Commit, { done: committed }, ${element})`
  const [api, mount] = clientOnly
    ? ['createRoot', `const root = createRoot(host, { identifierPrefix: ${JSON.stringify(c.id)} }); root.render(${tree}); return () => root.unmount()`]
    : ['hydrateRoot', `const root = hydrateRoot(host, ${tree}, { identifierPrefix: ${JSON.stringify(c.id)} }); return () => root.unmount()`]
  let head = ''
  if (nested && compiled) {
    const comps = nested.map((id) => compiled.get(id)).filter((n): n is Compiled => n !== undefined)
    head =
      `import { Fragment } from 'react'\n` +
      comps.map((n, i) => `${componentImport(n, `N${i}`)}\n`).join('') +
      reviveSource(`{ ${comps.map((n, i) => `${JSON.stringify(n.id)}: N${i}`).join(', ')} }`)
  }
  return (
    writerImports(writers) +
    `import { ${api} } from 'react-dom/client'\nimport { createElement, useLayoutEffect } from 'react'\n${componentImport(c, 'Comp')}\n${head}` +
    `const __Commit = ({ done, children }: any) => { useLayoutEffect(() => { done?.() }, []); return children }\n` +
    `;((globalThis as any).__brustIslands ||= []).push([${JSON.stringify(c.id)}, (host: Element, props: any, committed?: () => void) => { ${mount} }])\n` +
    `;(globalThis as any).__brustIslandReady?.()\n`
  )
}

/** F230: side-effect imports of the load-time writer modules (absolute paths), in a stable order. */
function writerImports(writers: string[]): string {
  return [...new Set(writers)].map((w) => `import ${JSON.stringify(w)}\n`).join('')
}

/** One island chunk per react-tier component (`react-<id>-<hex>.js`, contract 3), React split
 * into a shared chunk the island chunks import relatively. */
/** The react-tier components that get an island entry: all of them, except a package export (S1.4: every member of a
 * package import is one) that no static or native template places as an island. Inside a React component, or as a
 * component an island revives from its lowered children (`nestedOf`, S1 R34.21: those sit in the parent's
 * `ir.children` too), it is an ordinary element of that tree, not an island, and an entry for it only reshuffles the
 * shared chunks (measured: +11-24 KB gzip on a page that never loads it). Placed = a `<brust-island data-id>` marker
 * in the printed template, the one thing the server hydrates. */
export function islandEntries(compiled: Map<string, Compiled>): Compiled[] {
  const placed = new Set<string>()
  for (const p of compiled.values()) {
    if (isReact(p)) continue
    for (const m of p.jinja.matchAll(/<brust-island\b[^>]*\bdata-id="([^"]+)"/g)) placed.add(m[1]!)
  }
  return [...compiled.values()].filter((c) => isReact(c) && (!c.ir.external || placed.has(c.id)))
}

/** `writersFor` (F230): the load-time writer modules an island's chunk must import first, from the app files the
 * island's code is (its component, and the components it revives); none when absent. */
export async function buildReactChunks(
  dist: string,
  compiled: Map<string, Compiled>,
  ctx: BrowserCtx,
  runtimeUrl: RuntimeUrls,
  routeRoots?: ReadonlySet<string>,
  writersFor?: (c: Compiled, files: string[]) => string[],
): Promise<Map<string, string>> {
  const entrypoints: string[] = []
  for (const c of islandEntries(compiled)) {
    const file = join(dist, '.stage', 'react', `react-${c.id}.tsx`)
    const own = [c, ...(nestedOf(compiled, c.id, routeRoots) ?? []).flatMap((id) => compiled.get(id) ?? [])]
    const files = own.filter((n) => !(n.ir.external ?? n.ir.dist)).map((n) => n.file)
    write(file, islandShim(c, compiled, routeRoots, writersFor?.(c, files) ?? []))
    stage(ctx.sourceOf, file, c)
    entrypoints.push(file)
  }
  if (entrypoints.length === 0) return new Map()
  const out = await browserBuild(dist, 'react islands', ctx, {
    entrypoints,
    splitting: true,
    external: [`${brustRoot(ctx)}/*`],
    plugins: [runtimeAliasPlugin(runtimeUrl), sourceDirPlugin(ctx.sourceOf, ctx.appRoot, [], 'browser'), exposePlugin(compiled)],
  })
  return new Map([...out].map(([stem, path]) => [stem.slice('react-'.length), path]))
}

/** Left to the worker at runtime by `dist/jobs.js`: one React, and the worker's own `@brust/core`
 * (bundling the server package would load a second copy whose worker auto-start runs inside the
 * worker and exits it). */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const JOBS_EXTERNALS = [...REACT_EXTERNALS, '@brust/core', '@brust/core/*', '@brust/runtime-dom', '@brust/runtime-dom/*']

const storesTable = (paths: string[]): string =>
  paths.length === 0 ? '' : `export const stores = {\n${paths.map((p, i) => `  ${JSON.stringify(p)}: S${i},`).join('\n')}\n}\n`

/** F6: in `jobs.js` the store API is the worker's own `@brust/core/store`, never a bundled copy. */
const workerStorePlugin: BunPlugin = {
  name: 'brust-worker-store',
  setup(b) {
    b.onResolve({ filter: /^@brust\/runtime-dom\/store(\/react)?$/ }, (a) => ({ path: a.path.replace('@brust/runtime-dom', '@brust/core'), external: true }))
  },
}

/** dist/actions.js externals: the jobs set plus Elysia, so the app, `@brust/core/elysia` and the
 * worker's `mountActions` share ONE elysia (instanceof, HTTPError) — ruling R7. */
const ACTIONS_EXTERNALS = [...JOBS_EXTERNALS, 'elysia', 'elysia/*', '@elysia/*']

/** `dist/actions.js` (M3-F E1): the actions entry for the worker (`target: 'bun'`). No `define`: Elysia
 * and app code read NODE_ENV at runtime (run.ts sets production). */
export async function buildActions(dist: string, entry: string, cssMaps: Map<string, Record<string, string>> = new Map(), basePath = ''): Promise<string> {
  const res = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', external: ACTIONS_EXTERNALS, plugins: [serverOnlyEmptyPlugin(), cssPlugin(cssMaps, join(dist, 'client'), basePath), workerStorePlugin] })
  if (!res.success) throw new BuildError('bundle', `actions: ${res.logs.map(String).join('\n')}`)
  write(join(dist, 'actions.js'), await res.outputs[0]!.text())
  return 'actions.js'
}

/** `dist/cache-adapter.js` (cache adapters R8): a custom adapter module for the worker (`target: 'bun'`), with
 * the actions externals so it shares the app's dependencies. */
export async function buildCacheAdapter(dist: string, entry: string, cssMaps: Map<string, Record<string, string>> = new Map()): Promise<string> {
  const res = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', external: ACTIONS_EXTERNALS, plugins: [serverOnlyEmptyPlugin(), cssPlugin(cssMaps, join(dist, 'client'))] })
  if (!res.success) throw new BuildError('bundle', `cache adapter: ${res.logs.map(String).join('\n')}`)
  write(join(dist, 'cache-adapter.js'), await res.outputs[0]!.text())
  return 'cache-adapter.js'
}

/** R34.96: a parent's job calls the job of each child fused into it through `brust-job:<component id>`, resolved here to
 * that child's staged job module (`fileOf`). Only a compiled component's id resolves, and only for a staged job file
 * (`isJobFile`, F186): any other importer (app or package source) fails the bundle, as does an unknown id. */
export function jobImportPlugin(fileOf: (id: string) => string | undefined, isJobFile: (importer: string) => boolean): BunPlugin {
  return {
    name: 'brust-job-import',
    setup(b) {
      b.onResolve({ filter: /^brust-job:/ }, (a) => {
        if (!isJobFile(a.importer)) throw new BuildError('bundle', `${a.importer}: brust-job: is for generated job modules only`)
        const id = a.path.slice('brust-job:'.length)
        const file = /^[A-Za-z0-9_$-]+$/.test(id) ? fileOf(id) : undefined
        if (file === undefined) throw new BuildError('bundle', `${a.importer}: no job module for ${JSON.stringify(id)}`)
        return { path: file }
      })
    },
  }
}

/** F512: JSON drops an `undefined` property, so brust-core would read a missed `find` (a top-level output that is
 * `undefined`) as a slot the job never wrote. The job returns `null` for it instead: React renders both nothing and
 * both are falsy. Top-level outputs only; nested values are left as they are. */
export const SLOTS_HELPER = `const __slots = (f: (p: any) => any) => (p: any) => {
  const r = f(p)
  if (r !== null && typeof r === 'object' && !Array.isArray(r)) for (const k of Object.keys(r)) if (r[k] === undefined) r[k] = null
  return r
}`

/** `dist/jobs.js` (`target: 'bun'`, React and `@brust/core` external): default export
 * `{ [componentId]: { precompute?, ssr? } }`; `ssr` only for react-tier, non-client_only components. */
export async function buildJobs(
  dist: string,
  compiled: Map<string, Compiled>,
  sourceOf: SourceOf,
  appRoot: string,
  stores: string[] = [],
  cssMaps: Map<string, Record<string, string>> = new Map(),
  routeRoots?: ReadonlySet<string>,
  /** F183 (`reachedJobs`): only these entries are written; every one when absent. */
  reached?: { planned: ReadonlySet<string>; ssr: ReadonlySet<string> },
  /** F230: app modules that write another module's exports when they load: imported first (see `islandShim`). */
  writers: string[] = [],
  /** F495: `[server] base_path`: an imported asset's URL carries it. */
  basePath = '',
): Promise<void> {
  const imports: string[] = [writerImports(writers).trimEnd(), "import { createElement } from 'react'", "import { renderToString } from 'react-dom/server'"].filter((l) => l !== '')
  const entries: string[] = []
  const storePaths = [...new Set(stores)].sort()
  for (const [i, p] of storePaths.entries()) {
    if (BUILTIN_STORE_MODULES.includes(p)) {
      imports.push(`import * as S${i} from ${JSON.stringify(p)}`) // a package module, external in jobs.js
      continue
    }
    if (isAbsolute(p) || posixOf(p).split('/').includes('..') || escapes(relative(appRoot, resolve(appRoot, p))) || !isFile(resolve(appRoot, p))) {
      throw new BuildError('store-module', `store module ${p} is not a file inside the app (${appRoot})`)
    }
    imports.push(`import * as S${i} from ${JSON.stringify(resolve(appRoot, p))}`)
  }
  // Components an island revives from its lowered children (shadcn S1): one registry for every SSR job.
  const reviving = [...compiled.values()].filter((c) => nestedOf(compiled, c.id, routeRoots) !== undefined)
  const revived = [...revivedIds(compiled)].map((id) => compiled.get(id)).filter((x): x is Compiled => x !== undefined)
  if (reviving.length > 0) {
    imports.push("import { Fragment } from 'react'")
    for (const [i, r] of revived.entries()) imports.push(componentImport(r, `N${i}`))
    imports.push(reviveSource(`{ ${revived.map((r, i) => `${JSON.stringify(r.id)}: N${i}`).join(', ')} }`))
  }
  const hosts = new Set(reviving.map((c) => c.id))
  const jobFiles = new Set<string>() // the staged job modules: the only importers of `brust-job:` (F186)
  let n = 0
  for (const c of compiled.values()) {
    const fns: string[] = []
    if (c.serverTs !== undefined) {
      // Staged even when unreached: a parent's fused job imports it (`brust-job:<id>`, R34.96).
      const file = join(dist, 'jobs', `${c.id}.server.ts`)
      write(file, c.serverTs)
      stage(sourceOf, file, c)
      jobFiles.add(file).add(realpathSync(file))
      if (reached === undefined || reached.planned.has(c.id)) {
        imports.push(`import * as j${n} from ${JSON.stringify(file)}`)
        fns.push(`precompute: __slots(j${n}.precompute)`)
      }
    }
    if (isReact(c) && !c.ir.tier.React.client_only && (reached === undefined || reached.ssr.has(c.id))) {
      imports.push(componentImport(c, `C${n}`))
      // Ruling 2bf3775a (R1): the island's component id prefixes React's useId on BOTH sides
      // (the shim's hydrateRoot passes the same prefix), so ids differ across islands.
      fns.push(`ssr: (props: any) => renderToString(${hosts.has(c.id) ? `__mk(C${n}, props, ${JSON.stringify(xOf(compiled, c.id))}, ${JSON.stringify(holesOf(compiled, c.id))})` : `createElement(C${n}, props)`}, { identifierPrefix: ${JSON.stringify(c.id)} })`)
    }
    if (fns.length > 0) entries.push(`  ${JSON.stringify(c.id)}: { ${fns.join(', ')} },`)
    n++
  }
  const entry = join(dist, '.stage', 'jobs.ts')
  write(entry, `${imports.join('\n')}\n${SLOTS_HELPER}\nexport default {\n${entries.join('\n')}\n}\n${storesTable(storePaths)}`)
  const res = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    define: PRODUCTION,
    external: JOBS_EXTERNALS,
    plugins: [
      jobImportPlugin(
        (id) => (compiled.get(id)?.serverTs !== undefined ? join(dist, 'jobs', `${id}.server.ts`) : undefined),
        (importer) => jobFiles.has(importer),
      ),
      serverOnlyEmptyPlugin(),
      cssPlugin(cssMaps, join(dist, 'client'), basePath),
      workerStorePlugin,
      sourceDirPlugin(sourceOf, appRoot, JOBS_EXTERNALS),
      exposePlugin(compiled),
    ],
  })
  if (!res.success) throw new BuildError('bundle', `jobs: ${res.logs.map(String).join('\n')}`)
  write(join(dist, 'jobs.js'), await res.outputs[0]!.text())
}

/** C3: the sorted unique union of every component's `stores` (store module paths, app-root relative).
 * Tolerant of the field's absence until the compiler lane writes it. */
export function storeModules(m: { components: Record<string, unknown> }): string[] {
  const all = new Set<string>()
  for (const c of Object.values(m.components)) for (const p of (c as { stores?: string[] }).stores ?? []) all.add(p)
  return [...all].sort()
}
