// Bundles of `brust build` (plan T6, spec S5 step 3): the client runtime, native/static component
// chunks (modules they share split into common chunks), one react island chunk per react-tier
// component (shared React split out), and the server-side jobs module. Every staged artifact's
// relative imports resolve against its component's SOURCE directory through `sourceDirPlugin`;
// nothing is copied next to generated files. Every browser build refuses server-only code
// (`serverOnlyPlugin`) and resolves `@brust/core` to its browser-safe entry. Browser outputs are
// renamed to `<stem>-<sha256 hex10>.js` so the server serves them `immutable` (`pipeline.rs`
// `is_hashed` wants lowercase hex; Bun's `[hash]` is base36).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { BunPlugin } from 'bun'
import type { Compiled } from './compile'
import { BuildError } from './errors'

const REACT_EXTERNALS = ['react', 'react/*', 'react-dom', 'react-dom/*']
/** Production React (and the production JSX transform: `react/jsx-runtime`, never `jsxDEV`). */
const PRODUCTION = { 'process.env.NODE_ENV': JSON.stringify('production') }

const matchesExternal = (spec: string, external: string[]) =>
  external.some((p) => (p.endsWith('/*') ? spec.startsWith(p.slice(0, -1)) : spec === p))

/** Staged artifact (by its absolute and its real path) → the component SOURCE file it was
 * generated from. */
export type SourceOf = Map<string, string>

/** What every browser build needs to know about the app. */
export interface BrowserCtx {
  sourceOf: SourceOf
  appRoot: string
  /** `brust.toml` `[build] server_only`: import prefixes / app-root-relative paths. */
  serverOnly: string[]
}

/** Resolution for staged artifacts (`importer` = a staged file registered in `sourceOf`): relative
 * imports mean the component's SOURCE directory; bare imports (`react`, `react-dom/client`, npm
 * packages) resolve from `appRoot`, never from wherever `dist/` sits (an `--out-dir` outside the
 * app has no `node_modules` above it). `external` specifiers are left to Bun so they stay
 * external. */
export function sourceDirPlugin(sourceOf: SourceOf, appRoot: string, external: string[] = []): BunPlugin {
  return {
    name: 'brust-source-dir',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (a) => {
        const src = sourceOf.get(a.importer)
        return src === undefined ? undefined : { path: Bun.resolveSync(a.path, dirname(src)) }
      })
      b.onResolve({ filter: /^[^./]/ }, (a) => {
        if (!sourceOf.has(a.importer) || matchesExternal(a.path, external)) return undefined
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
 * `[build] server_only`. A bare specifier is matched against `server_only` as written (an entry
 * can name a package), and EVERY specifier is also checked by the file it resolves to (Bun's
 * resolver honours tsconfig `paths`, so an alias cannot bypass the `*.server.*` / path rules). */
function isServerOnly(spec: string, importer: string, ctx: BrowserCtx): boolean {
  if (spec.startsWith('node:') || spec.startsWith('bun:') || spec === 'bun') return true
  const from = dirname(ctx.sourceOf.get(importer) ?? importer)
  const bare = spec.split('/')[0]!
  if ((BUILTINS.has(spec) || BUILTINS.has(bare)) && !(BROWSER_POLYFILLS.has(bare) && installed(bare, from, ctx.appRoot))) return true
  if (/^@brust\/brust\/(server|native)(\/|$)/.test(spec)) return true
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
  const rel = relative(ctx.appRoot, file)
  return !rel.startsWith('..') && !isAbsolute(rel) && ctx.serverOnly.some((p) => rel.startsWith(p))
}

/** Fails a browser build that would include server-only code at any depth (a client chunk, an
 * island, or any module either reaches), and points `@brust/core` at its browser-safe entry. An
 * offending import is stubbed so the bundler gets as far as it can; `browserBuild` then throws
 * `server-only-in-client` naming every `<importer> imports <spec>`. */
function serverOnlyPlugin(ctx: BrowserCtx, violations: string[]): BunPlugin {
  return {
    name: 'brust-server-only',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (!a.importer || a.path.startsWith('/_brust/')) return undefined
        if (a.path === '@brust/core') return { path: BROWSER_ENTRY }
        if (!isServerOnly(a.path, a.importer, ctx)) return undefined
        const msg = `${relative(ctx.appRoot, ctx.sourceOf.get(a.importer) ?? a.importer)} imports ${a.path}`
        if (!violations.includes(msg)) violations.push(msg)
        return { path: a.path, namespace: SERVER_ONLY_NS }
      })
      b.onLoad({ filter: /.*/, namespace: SERVER_ONLY_NS }, () => ({ contents: 'export default {}', loader: 'js' }))
    },
  }
}

const hex = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10)
const write = (file: string, text: string) => {
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
): Promise<Map<string, string>> {
  const violations: string[] = []
  const fail = () => new BuildError('server-only-in-client', `${what}: ${violations.join('; ')} (server-only code in a browser bundle)`)
  let res: Awaited<ReturnType<typeof Bun.build>>
  try {
    res = await Bun.build({
      ...config,
      plugins: [serverOnlyPlugin(ctx, violations), ...(config.plugins ?? [])],
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

/** `dist/client/runtime-<hex>.js`: runtime-dom, re-exported (client chunks import `signal`,
 * `defineBehavior`, … from this URL) and mounted on `document.documentElement` (contract 6). */
export async function buildRuntime(dist: string, ctx: BrowserCtx): Promise<string> {
  const entry = join(dist, '.stage', 'runtime.ts')
  write(entry, "export * from '@brust/runtime-dom'\nimport { mount } from '@brust/runtime-dom'\nmount(document.documentElement)\n")
  // Resolved from this package (its dependency), not from wherever `dist/` sits.
  const runtimeDom = Bun.resolveSync('@brust/runtime-dom', import.meta.dir)
  const res = await browserBuild(dist, 'runtime', ctx, {
    entrypoints: [entry],
    plugins: [
      {
        name: 'brust-runtime-dom',
        setup(b) {
          b.onResolve({ filter: /^@brust\/runtime-dom$/ }, () => ({ path: runtimeDom }))
        },
      },
    ],
  })
  return res.get('runtime')!
}

/** One entry chunk per component with client JS (`<id>-<hex>.js`), split: a module two chunks
 * import (a store) lands once in a shared `chunk-<hex>.js`, so one page has one instance of it.
 * The runtime import stays the absolute `/_brust/client/runtime-<hex>.js` URL the compiler
 * printed (external: one runtime for every chunk). */
export async function buildClientChunks(dist: string, compiled: Map<string, Compiled>, ctx: BrowserCtx): Promise<Map<string, string>> {
  const entrypoints: string[] = []
  for (const c of compiled.values()) {
    if (c.clientJs === undefined) continue
    const file = join(dist, '.stage', 'client', `${c.id}.js`)
    write(file, c.clientJs)
    stage(ctx.sourceOf, file, c)
    entrypoints.push(file)
  }
  if (entrypoints.length === 0) return new Map()
  return browserBuild(dist, 'client chunks', ctx, {
    entrypoints,
    splitting: true,
    external: ['/_brust/*'],
    plugins: [sourceDirPlugin(ctx.sourceOf, ctx.appRoot)],
  })
}

/** Registers a written artifact (by its path and its real path: the importer Bun reports). */
function stage(sourceOf: SourceOf, file: string, c: Compiled): void {
  sourceOf.set(file, c.file)
  sourceOf.set(realpathSync(file), c.file)
}

const isReact = (c: Compiled) => typeof c.ir.tier === 'object' && c.ir.tier !== null && 'React' in c.ir.tier

/** The island entry of a react-tier component: registers `(host, props) => …` under its id. A
 * `client_only` component was never server-rendered (its host is empty), so it mounts with
 * `createRoot`; hydrating it would fail (React #418). Everything else hydrates the SSR markup. */
export function islandShim(c: Compiled): string {
  const clientOnly = c.ir.tier?.React?.client_only === true
  const [api, mount] = clientOnly
    ? ['createRoot', `createRoot(host, { identifierPrefix: ${JSON.stringify(c.id)} }).render(createElement(Comp, props))`]
    : ['hydrateRoot', `hydrateRoot(host, createElement(Comp, props), { identifierPrefix: ${JSON.stringify(c.id)} })`]
  return (
    `import { ${api} } from 'react-dom/client'\nimport { createElement } from 'react'\nimport Comp from ${JSON.stringify(c.file)}\n` +
    `;((globalThis as any).__brustIslands ||= []).push([${JSON.stringify(c.id)}, (host: Element, props: any) => { ${mount} }])\n` +
    `;(globalThis as any).__brustIslandReady?.()\n`
  )
}

/** One island chunk per react-tier component (`react-<id>-<hex>.js`, contract 3), React split
 * into a shared chunk the island chunks import relatively. */
export async function buildReactChunks(dist: string, compiled: Map<string, Compiled>, ctx: BrowserCtx): Promise<Map<string, string>> {
  const entrypoints: string[] = []
  for (const c of compiled.values()) {
    if (!isReact(c)) continue
    const file = join(dist, '.stage', 'react', `react-${c.id}.tsx`)
    write(file, islandShim(c))
    stage(ctx.sourceOf, file, c)
    entrypoints.push(file)
  }
  if (entrypoints.length === 0) return new Map()
  const out = await browserBuild(dist, 'react islands', ctx, {
    entrypoints,
    splitting: true,
    plugins: [sourceDirPlugin(ctx.sourceOf, ctx.appRoot)],
  })
  return new Map([...out].map(([stem, path]) => [stem.slice('react-'.length), path]))
}

/** Left to the worker at runtime by `dist/jobs.js`: one React, and the worker's own `@brust/core`
 * (bundling the server package would load a second copy whose worker auto-start runs inside the
 * worker and exits it). */
const JOBS_EXTERNALS = [...REACT_EXTERNALS, '@brust/core', '@brust/core/*']

/** `dist/jobs.js` (`target: 'bun'`, React and `@brust/core` external): default export
 * `{ [componentId]: { precompute?, ssr? } }`; `ssr` only for react-tier, non-client_only components. */
export async function buildJobs(dist: string, compiled: Map<string, Compiled>, sourceOf: SourceOf, appRoot: string): Promise<void> {
  const imports: string[] = ["import { createElement } from 'react'", "import { renderToString } from 'react-dom/server'"]
  const entries: string[] = []
  let n = 0
  for (const c of compiled.values()) {
    const fns: string[] = []
    if (c.serverTs !== undefined) {
      const file = join(dist, 'jobs', `${c.id}.server.ts`)
      write(file, c.serverTs)
      stage(sourceOf, file, c)
      imports.push(`import * as j${n} from ${JSON.stringify(file)}`)
      fns.push(`precompute: j${n}.precompute`)
    }
    if (isReact(c) && !c.ir.tier.React.client_only) {
      imports.push(`import C${n} from ${JSON.stringify(c.file)}`)
      // Ruling 2bf3775a (R1): the island's component id prefixes React's useId on BOTH sides
      // (the shim's hydrateRoot passes the same prefix), so ids differ across islands.
      fns.push(`ssr: (props: any) => renderToString(createElement(C${n}, props), { identifierPrefix: ${JSON.stringify(c.id)} })`)
    }
    if (fns.length > 0) entries.push(`  ${JSON.stringify(c.id)}: { ${fns.join(', ')} },`)
    n++
  }
  const entry = join(dist, '.stage', 'jobs.ts')
  write(entry, `${imports.join('\n')}\nexport default {\n${entries.join('\n')}\n}\n`)
  const res = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    define: PRODUCTION,
    external: JOBS_EXTERNALS,
    plugins: [sourceDirPlugin(sourceOf, appRoot, JOBS_EXTERNALS)],
  })
  if (!res.success) throw new BuildError('bundle', `jobs: ${res.logs.map(String).join('\n')}`)
  write(join(dist, 'jobs.js'), await res.outputs[0]!.text())
}
