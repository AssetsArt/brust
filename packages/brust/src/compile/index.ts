// F518 `@brust/core/compile`: compile ONE component from source text, long after `brust build`, into a runtime artifact an
// app stores and hands back to `<Dynamic>` (F519). It compiles exactly as the build would: the same compiler, the build's
// `brust.toml` (source_roots, server_only) and tsconfig aliases, the runtime URLs and the exposed modules `dist/manifest.json`
// names. Bun only (the addon and `Bun.build`): refused in a browser bundle like `./native`.
//
// What is compiled is a FILE NAME plus text: nothing is written under the app root. The name decides how relative imports
// resolve; the artifact id is a function of (name, text) (see `virtualPath`).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { type CompiledComponent, compileSource } from '../../native/index.js'
import { loadBuildConfig } from '../build/config'
import { featuresOf, importsStore } from '../build/features'
import { tierOf } from '../build/manifest'
import { readPathAliases } from '../build/tsconfig-paths'
import { bundleClient } from './client'
import { exposedByPath, resolveSpec } from './resolve'

/** The result of `compileComponent`, opaque to the app: it stores and returns it. JSON-serialisable; valid for ONE build. */
export interface RuntimeArtifact {
  v: 1
  /** `assets.build` of the manifest this artifact was compiled for. */
  build: string
  /** The `x-data` / `defineBehavior` id: a function of (filename, source bytes). */
  id: string
  tier: 'static' | 'native'
  jinja: string
  /** ONE self-contained ES module (no splitting); `null` for a static component. */
  client: string | null
  /** Names of the client runtime feature modules (and `store`) the output needs. */
  features: string[]
  /** Store NAMES it reads; each is one an exposed module defines (`runtime.stores` of the manifest). */
  stores: string[]
}

/** The compiler's finding shape (`NapiDiagnostic`), plus the runtime-component rules of this module. */
export interface Diagnostic {
  class: 'fallback' | 'error' | 'warning' | 'info' | string
  rule: string
  message: string
  line: number
  col: number
  remediation: string
  /** The module `line`/`col` point into when it is not the compiled file (an inlined component's file). */
  file?: string | null
}

export type CompileResult = { ok: true; artifact: RuntimeArtifact; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] }

export interface CompileOptions {
  /** The component's source text (TSX). */
  source: string
  /** A virtual app-root-relative path (`el/Promo.tsx`): it decides how relative imports resolve. Nothing is written there. */
  filename: string
  /** The app root (where `brust.toml` and `package.json` are); default: the working directory. */
  appRoot?: string
  /** The build output; default `<appRoot>/dist`. */
  dist?: string
}

/** The limits at registration (R2), in UTF-8 bytes. */
export const MAX_JINJA_BYTES = 256 * 1024
export const MAX_CLIENT_BYTES = 256 * 1024

const err = (rule: string, message: string, remediation = '', extra: Partial<Diagnostic> = {}): Diagnostic => ({ class: 'error', rule, message, line: 0, col: 0, remediation, ...extra })

interface Context {
  build: string
  base: string
  runtimeUrl: string
  storeUrl: string
  /** `client/rt-store-<hex>.js`, the file `importsStore` looks for. */
  storeFile: string
  exposed: Record<string, string>
  stores: Record<string, string>
  serverOnly: string[]
  sourceRoots: string[]
  aliasesJson: string | undefined
}

interface Manifest {
  base_path?: string
  assets: { runtime: string; features: Record<string, string>; build?: string }
  runtime?: { exposed?: Record<string, string>; stores?: Record<string, string> }
}

const contexts = new Map<string, { stamp: string; ctx: Context }>()

/** What the build wrote and configured, read once per (app, dist) and again when the manifest changes. */
async function contextOf(appRoot: string, dist: string): Promise<Context> {
  const file = join(dist, 'manifest.json')
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(file)
  } catch {
    throw new Error(`@brust/core/compile: ${file} does not exist; run \`brust build\` first (a runtime component is compiled against one build)`)
  }
  const toml = join(appRoot, 'brust.toml')
  const stamp = `${st.mtimeMs}:${st.size}:${existsSync(toml) ? statSync(toml).mtimeMs : 0}`
  const key = `${appRoot}\0${dist}`
  const hit = contexts.get(key)
  if (hit?.stamp === stamp) return hit.ctx
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest
  const build = m.assets?.build
  const store = m.assets?.features?.store
  if (typeof build !== 'string' || typeof store !== 'string' || typeof m.assets?.runtime !== 'string')
    throw new Error(`@brust/core/compile: ${file} is not a manifest this version can compile against (assets.build, assets.runtime and assets.features.store are required)`)
  const cfg = await loadBuildConfig(appRoot)
  const base = m.base_path ?? ''
  const { aliases } = readPathAliases(appRoot)
  const ctx: Context = {
    build,
    base,
    runtimeUrl: `${base}/_brust/${m.assets.runtime}`,
    storeUrl: `${base}/_brust/${store}`,
    storeFile: store,
    exposed: m.runtime?.exposed ?? {},
    stores: m.runtime?.stores ?? {},
    serverOnly: cfg.serverOnly,
    sourceRoots: cfg.sourceRoots,
    aliasesJson: aliases.length > 0 ? JSON.stringify(aliases) : undefined,
  }
  contexts.set(key, { stamp, ctx })
  return ctx
}

/**
 * The name the compiler sees. The artifact id the compiler derives is the camel-cased file stem, `_` and 8 hex digits of
 * the path's hash, so the content goes INTO the stem: `el/Promo.tsx` + text → `el/Promo-<16 hex>.tsx` (64 bits of the
 * text's SHA-256), whose id reads `promo<16 hex>_<8 hex>`: letters and digits only, a URL segment. A changed text is a new
 * id; equal (filename, text) is the same id on every machine. Two filenames with equal text differ (the stem and the path
 * hash both change): the filename is part of the identity because it decides how relative imports resolve.
 */
export function virtualPath(filename: string, source: string): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const slash = filename.lastIndexOf('/')
  const dir = filename.slice(0, slash + 1)
  const file = filename.slice(slash + 1)
  const dot = file.indexOf('.')
  return `${dir}${dot < 0 ? file : file.slice(0, dot)}-${hash}${dot < 0 ? '' : file.slice(dot)}`
}

/** Bare specifiers a runtime component's source may import besides an exposed module (the compiler resolves them natively). */
const ALLOWED_BARE = new Set(['react', '@brust/core/store/react'])

/** 1-based line and column of the first quoted `spec` in `source`. */
function locate(source: string, spec: string): { line: number; col: number } {
  const at = Math.max(source.indexOf(`'${spec}'`), source.indexOf(`"${spec}"`))
  if (at < 0) return { line: 0, col: 0 }
  const before = source.slice(0, at)
  return { line: before.split('\n').length, col: at - before.lastIndexOf('\n') }
}

let scanner: InstanceType<typeof Bun.Transpiler> | undefined
/** R3.4 `runtime-import`: every runtime import of the source is an exposed module, `react` or the store bridge. A private copy of an app module would split its state. */
function checkImports(source: string, filename: string, appRoot: string, ctx: Context): Diagnostic[] {
  scanner ??= new Bun.Transpiler({ loader: 'tsx' })
  const exposed = exposedByPath(appRoot, ctx.exposed)
  const from = dirname(resolve(appRoot, filename))
  const out: Diagnostic[] = []
  let imports: { path: string }[]
  try {
    // `scan`, not `scanImports`: the latter adds the JSX runtime import the transpiler would insert. Type-only imports are erased by the parser.
    imports = scanner.scan(source).imports
  } catch {
    return out // a source that does not parse: the compiler reports that, with its own position
  }
  for (const i of imports) {
    if (ALLOWED_BARE.has(i.path)) continue
    const file = resolveSpec(i.path, from, appRoot)
    if (file !== undefined && exposed.has(file)) continue
    out.push(
      err(
        'runtime-import',
        `imports "${i.path}", which is not an exposed module: a runtime component shares app code only through \`[build] expose\`, because a private copy of an app module would split its state`,
        `list the module in brust.toml \`[build] expose\` and rebuild, or remove the import`,
        locate(source, i.path),
      ),
    )
  }
  return out
}

/** The file name a diagnostic should show: the compiler saw the virtual path. */
function renameIn(d: Diagnostic, virtual: string, filename: string): Diagnostic {
  const fix = (s: string) => s.split(virtual).join(filename)
  return { ...d, message: fix(d.message), remediation: fix(d.remediation), file: d.file == null || d.file === virtual ? undefined : d.file }
}

const fromNapi = (d: { class: string; rule: string; message: string; line: number; col: number; remediation: string; file?: string | null }): Diagnostic => ({
  class: d.class,
  rule: d.rule,
  message: d.message,
  line: d.line,
  col: d.col,
  remediation: d.remediation,
  file: d.file ?? undefined,
})

type Ir = Record<string, any> // biome-ignore lint/suspicious/noExplicitAny: IR JSON, read structurally

/** R3.4: what this tree needs that a runtime component cannot have. */
function checkTree(tree: CompiledComponent[], ctx: Context, jinja: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const names = new Set<string>()
  for (const c of tree) {
    const ir = JSON.parse(c.ir) as Ir
    const where = c.source
    if (tierOf(ir as never) === 'react') {
      const t = ir.tier?.React
      const why = c.diagnostics.filter((d) => d.class === 'fallback').map((d) => `${d.rule}: ${d.message}`)
      out.push(
        err(
          'runtime-tier',
          `${where} falls back to the React tier (${t?.reason ?? 'unknown reason'}${why.length > 0 ? `; ${why.join('; ')}` : ''}): a runtime component must compile static or native`,
          'rewrite it with what the native compiler accepts; `brust build` explains the same refusal for a route component',
        ),
      )
    }
    const jobs = (ir.jobs ?? []) as { kind: unknown; inputs: string[]; outputs: string[] }[]
    if (jobs.length > 0 || (ir.build_eval ?? []).length > 0) {
      const slot = (ir.build_eval ?? [])[0] as { line: number; col: number } | undefined
      const kinds = [...new Set(jobs.map((j) => (typeof j.kind === 'string' ? j.kind.toLowerCase() : 'ssr')))].join(', ')
      out.push(
        err(
          'runtime-jobs',
          `${where} needs a server job (${kinds || 'build-time evaluation'}) computing ${jobs.flatMap((j) => j.outputs).join(', ') || 'a build-time value'}${jobs.length > 0 ? ` from ${[...new Set(jobs.flatMap((j) => j.inputs))].join(', ') || 'constants'}` : ''}${c.serverTs ? `: ${firstLine(c.serverTs)}` : ''}: a runtime component runs no jobs`,
          'compute the value in the page loader and pass it as a prop',
          { line: slot?.line ?? 0, col: slot?.col ?? 0 },
        ),
      )
    }
    if ((ir.instances ?? []).length > 0 || (ir.child_links ?? []).length > 0)
      out.push(err('runtime-children', `${where} renders a child component the server must feed per instance (a precompute job or useId): a runtime component's children are inlined and static`, 'inline the child or pass what it needs as props'))
    if ((ir.use_id_slots ?? 0) > 0) out.push(err('runtime-use-id', `${where} calls useId(): the server seeds its values per instance and a runtime component has no instance record`, 'pass an explicit id prop'))
    for (const s of (ir.stores ?? []) as { resolved: { name: string } | null }[]) if (s.resolved) names.add(s.resolved.name)
  }
  for (const n of names)
    if (!(n in ctx.stores)) out.push(err('runtime-store', `reads the store "${n}", which no exposed module defines (runtime.stores lists ${Object.keys(ctx.stores).join(', ') || 'none'})`, 'export it from a module listed in `[build] expose` and rebuild'))
  if (/\bbrust_dynamic\s*\(/.test(jinja)) out.push(err('runtime-dynamic', 'contains a <Dynamic> slot: a runtime component cannot place another runtime component', 'place it from a page or layout of the app'))
  return out
}

const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('//')) ?? '').trim().slice(0, 120)

const bytes = (s: string): number => new TextEncoder().encode(s).length

/**
 * Compiles `source` as the app's build would and returns the runtime artifact, or the diagnostics that refuse it.
 * Throws only for a missing or foreign `dist/manifest.json` and for arguments that are not a source and an app-relative
 * file name; a source the compiler or R3.4 refuses is `{ ok: false }`.
 */
export async function compileComponent(opts: CompileOptions): Promise<CompileResult> {
  if (typeof opts?.source !== 'string') throw new TypeError('compileComponent: `source` must be a string')
  const filename = typeof opts.filename === 'string' ? opts.filename.replace(/\\/g, '/').replace(/^\.\//, '') : ''
  if (filename === '' || isAbsolute(filename) || filename.split('/').includes('..') || filename.includes('\0') || !/\.[jt]sx$/.test(filename) || /(^|\/)\.[^/]*$/.test(filename))
    throw new TypeError('compileComponent: `filename` must be a virtual app-root-relative path to a .tsx or .jsx file (`el/Promo.tsx`)')
  const appRoot = resolve(opts.appRoot ?? process.cwd())
  const dist = resolve(opts.dist ?? join(appRoot, 'dist'))
  const ctx = await contextOf(appRoot, dist)
  const { source } = opts

  const importProblems = checkImports(source, filename, appRoot, ctx)
  const virtual = virtualPath(filename, source)
  const tree = compileSource({
    path: virtual,
    source,
    root: appRoot,
    runtimeImport: ctx.runtimeUrl,
    serverOnly: ctx.serverOnly,
    pathAliases: ctx.aliasesJson,
    sourceRoots: ctx.sourceRoots.length > 0 ? ctx.sourceRoots : undefined,
    // Icons are never rendered here: every lucide icon is judged an island (`runtime-tier`).
    iconSvgs: JSON.stringify({ final: true, svgs: {} }),
  })
  const rename = (d: Diagnostic) => renameIn(d, virtual, filename)
  if (tree.error) return { ok: false, diagnostics: [...importProblems, rename(fromNapi(tree.error))] }
  const diagnostics = [...importProblems, ...tree.components.flatMap((c) => c.diagnostics.map((d) => rename(fromNapi(d))))]
  const root = tree.components[0]!
  const refusals = checkTree(tree.components, ctx, root.jinja).map(rename)
  if (diagnostics.some((d) => d.class === 'error') || refusals.length > 0) return { ok: false, diagnostics: [...diagnostics, ...refusals] }

  const client = await bundleClient(tree.components, ctx, { appRoot, filename })
  if (client.problems.length > 0) return { ok: false, diagnostics: [...diagnostics, ...client.problems.map(rename)] }
  const sizes: Diagnostic[] = []
  if (bytes(root.jinja) > MAX_JINJA_BYTES) sizes.push(err('runtime-size', `the template is ${bytes(root.jinja)} bytes; the limit is ${MAX_JINJA_BYTES}`, 'split the component or trim its markup'))
  if (client.code !== null && bytes(client.code) > MAX_CLIENT_BYTES) sizes.push(err('runtime-size', `the client module is ${bytes(client.code)} bytes; the limit is ${MAX_CLIENT_BYTES}`, 'import shared code from an exposed module instead of bundling it'))
  if (sizes.length > 0) return { ok: false, diagnostics: [...diagnostics, ...sizes] }

  // R3.6: the build's own `featuresOf`, then the store rule the build applies to a chunk that imports the store module. An
  // artifact that reads a store reaches that module through the exposed module that defines it, so it counts too.
  const features: string[] = featuresOf(root.id, root.jinja, false)
  const stores = [...new Set(tree.components.flatMap((c) => ((JSON.parse(c.ir) as Ir).stores ?? []) as { resolved: { name: string } | null }[]).flatMap((s) => (s.resolved ? [s.resolved.name] : [])))].sort()
  const chunk = 'client/runtime-component.js'
  if ((stores.length > 0 || (client.code !== null && importsStore((rel) => (rel === chunk ? client.code! : undefined), chunk, ctx.storeFile))) && !features.includes('store')) features.push('store')
  // The root can be a static shell around a native child: the page needs the runtime whenever there is client code.
  const tier = client.code === null ? 'static' : 'native'
  const artifact: RuntimeArtifact = { v: 1, build: ctx.build, id: root.id, tier, jinja: root.jinja, client: client.code, features, stores }
  return { ok: true, artifact, diagnostics }
}
