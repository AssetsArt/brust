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

/** One call (or `new`) a handler reaches (F520, F538). */
export interface CalleeFact {
  /** The callee as written (`fetch`, `bump`, `e.target.remove`); an alias is named for what it aliases (`const f = window.fetch; f()` is `window.fetch`); empty for a call-result callee. */
  name: string
  /**
   * `import` (an imported binding), `local` (a function written in the file), `setter` (React's `useState`/`useReducer` setter),
   * `prop` (a parameter of an enclosing function, or a name destructured from or aliasing one: the component's props, a helper's argument. Caller-supplied, so never `local`; claimed only for a parameter that is never reassigned, never handed to a call, and none of whose members (or its aliases' members) is written in the file),
   * `prop-member` (a member chain rooted at one: `props.onSave`),
   * `global` (an unbound identifier), `global-member` (a member chain rooted at a global or at a name that aliases one: `document.body.append`),
   * `param-member` (rooted at a parameter or a name derived from one: `e.target.remove`), `member` (rooted at anything else; `from` is set when the root is imported),
   * `unknown` (a call-result callee, a function passed in as a parameter, a name the file does not fix: assigned twice, a loop variable).
   * A handler that is not a function written in the file (`onClick={props.go}`, `onClick={sdk.bump}`) is itself listed as a callee.
   */
  kind: 'import' | 'local' | 'setter' | 'prop' | 'prop-member' | 'global' | 'global-member' | 'param-member' | 'member' | 'unknown'
  from?: string
}

/** One assignment, update (`++`, `--`) or `delete` in a handler or in a local function it reaches (F538). */
export interface WriteFact {
  line: number
  col: number
  /**
   * What the written place is rooted at: `local` (a variable the handler declares, or a property of an object literal it made, one level deep), `param` (a parameter
   * variable itself: `e = x`), `param-member` (through a parameter or an alias of one: `e.currentTarget.innerHTML = x`), `prop-member` (through a parameter of
   * an enclosing function, such as the component's props: `props.obj.x = 1`), `closure` (a variable of the enclosing component or module: `count = 1`),
   * `closure-member` (a property reached through one: `ref.current = x`), `global` (`location = x`), `global-member`
   * (`document.title = x`, `window.location.href = x`), `other` (anything the walk cannot trace: a call result, `this`, a loop variable, a name assigned from several sources).
   */
  target: 'local' | 'param' | 'param-member' | 'prop-member' | 'closure' | 'closure-member' | 'global' | 'global-member' | 'other'
  /** The written place as the source spells it, best effort (`e.currentTarget.innerHTML`, `items[?].x`). */
  path: string
}

/** A local function a handler reaches (F538). */
export interface FnRef {
  name: string
  line: number
  col: number
}

/** What one `onX` prop's function does (F520, F538). */
export interface HandlerFact {
  /** The prop without `on`, lower-cased. */
  event: string
  tag: string
  line: number
  col: number
  /** The calls its function makes: block bodies, nested callbacks and every local function it reaches (by call or by naming it). */
  callees: CalleeFact[]
  /** Every assignment, update and `delete` it performs, the local functions it reaches included, in source order. `e.currentTarget.innerHTML = x` calls nothing: this is where it shows. */
  writes: WriteFact[]
  /** It reads one of its own parameters. A destructuring signature, `arguments` and a handler the file does not show (a prop, an import) count; an unused `(e) =>` does not. */
  readsParams: boolean
  /** Every unbound name its code reaches, the local functions it reaches included. Sorted. */
  globals: string[]
  /** The local functions it reaches, each with its own entry in `Facts.functions`. */
  reaches: FnRef[]
}

/** What one local function does in its own body (F538): the rule applied to a handler can be applied to each function behind it. */
export interface FnFact extends FnRef {
  writes: WriteFact[]
  readsParams: boolean
  globals: string[]
  callees: CalleeFact[]
  /** The local functions its body names. */
  reaches: FnRef[]
}

/**
 * What the source FILE refers to (F520, R6), from the compiler's own parse and symbol table, over the whole file: the
 * render, every handler and effect, and module-level helpers. Present whenever the text parses, on `ok: false` too.
 *
 * The facts NAME what the source refers to; they are an input to an allowlist, not a proof of isolation: a computed member
 * (`window[k]`), `eval` or a dynamic `import()` can reach a name the walk never sees (they are listed in `risky` so a check
 * can refuse them), and what an imported function does is outside the file. Pair them with a Content-Security-Policy.
 * Type-only imports are erased by the parser before this walk and never appear in `imports`.
 *
 * Facts are a REPORT, not a sandbox, and policy stays with the caller. For handlers, allow-list writes whose `target` is `local` and callees
 * whose `kind` is `setter` or `local`; refuse everything else, including what the walk could not trace (`other`, `unknown`). Effects (`useEffect`),
 * callback refs (`ref={fn}`) and module-level code are named by `hooks`, `attrs` and `globals`; their writes are not listed.
 */
export interface Facts {
  /** Runtime imports, one entry per specifier as written; `names`: imported names (`default`, `*`), empty for a bare import, `require()` or `import('x')`. */
  imports: { specifier: string; names: string[] }[]
  /** Every unbound identifier read, written or called (`fetch`, `document`, `window`, `Math`), sorted. */
  globals: string[]
  /** Calls named `useX` (bare or a member such as `React.useState`); `from`: the specifier it is imported from, `null` for a local or global one. */
  hooks: { name: string; from: string | null }[]
  /** JSX tags: host elements and components as written (`Dialog.Root`); fragments excluded. Sorted. */
  tags: string[]
  /** Every prop name written on a JSX element, incl. `dangerouslySetInnerHTML`, `ref`, `style`. Sorted. */
  attrs: string[]
  /** A JSX spread attribute appears. */
  spreads: boolean
  /** `dangerouslySetInnerHTML` is written on an element. */
  rawHtml: boolean
  /** Every `onX` prop in source order, with what its function calls, writes and reads (block bodies, nested callbacks and the local functions it reaches included). */
  handlers: HandlerFact[]
  /** Every local function some handler reaches, with the same facts for its own body. Sorted by position. */
  functions: FnFact[]
  /** Constructs that can reach a name the walk cannot see, in source order. */
  risky: { kind: 'dynamic-import' | 'computed-member' | 'constructor-access' | 'eval'; line: number; col: number }[]
}

export type CompileResult =
  | { ok: true; artifact: RuntimeArtifact; diagnostics: Diagnostic[]; facts?: Facts }
  | { ok: false; diagnostics: Diagnostic[]; facts?: Facts }

/** The longest artifact id the app's registry accepts. */
export const MAX_ID_LENGTH = 128

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
/** F550: the source's scanner. `macro: false` is the only setting that keeps Bun from RUNNING a macro import while it
 * parses (`macro: {}` does not; the types allow only a map, hence the cast); with it a macro import throws "Macros are disabled" and nothing runs. */
const sourceScanner = (): InstanceType<typeof Bun.Transpiler> => (scanner ??= new Bun.Transpiler({ loader: 'tsx', macro: false as never }))

/** F550: where the first `with { type: "macro" }` (or `assert`) import attribute is, 1-based; 0:0 when not found. */
function macroAt(source: string): { line: number; col: number } {
  const m = /\b(?:with|assert)\s*\{[^}]*\btype\s*:\s*['"]macro['"]/.exec(source)
  if (!m) return { line: 0, col: 0 }
  const before = source.slice(0, m.index)
  return { line: before.split('\n').length, col: m.index - before.lastIndexOf('\n') }
}

/**
 * F550 `runtime-macro`: a Bun macro import (`with { type: "macro" }`) runs its code when the source is parsed or bundled,
 * on the server, before any check. The source is scanned with macros disabled first, and one is refused here, before the
 * compiler and before any bundle.
 */
function checkMacros(source: string): Diagnostic[] {
  let disabled = false
  try {
    sourceScanner().scan(source)
  } catch (e) {
    disabled = /Macros are disabled/i.test(String(e))
  }
  // The scan says so for a macro import it reaches; the text catches one it does not (a re-export, a source the scan gives
  // up on before it). Either way nothing ran, and the import is refused here.
  const at = macroAt(source)
  if (!disabled && at.line === 0) return [] // no macro (a source that does not parse: the compiler reports that)
  return [
    err(
      'runtime-macro',
      'imports with `{ type: "macro" }`: a macro runs its code on the server when the source is parsed; a runtime component never runs code at compile time',
      'remove the macro import; compute the value in the page loader and pass it as a prop',
      at,
    ),
  ]
}

/** F550 (ruling 3): an import attribute (`with { … }` / `assert { … }`) changes how the import is loaded; a runtime
 * component needs none. Found in the text (`scan` does not report attributes): a match in a string is refused too. */
function checkImportAttributes(source: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const re = /(\bfrom\s*|\bimport\s*)(['"])([^'"\n]*)\2\s*(with|assert)\s*\{|\bimport\s*\(([^)]*?),\s*\{\s*(with|assert)\s*:/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const before = source.slice(0, m.index)
    const spec = m[3] ?? m[5]?.trim() ?? ''
    out.push(
      err(
        'runtime-import',
        `imports ${spec.startsWith("'") || spec.startsWith('"') ? spec : `"${spec}"`} with an import attribute (\`${m[4] ?? m[6]} { … }\`), which changes how it is loaded: a runtime component imports modules plainly`,
        'remove the import attribute, or the import',
        { line: before.split('\n').length, col: m.index - before.lastIndexOf('\n') },
      ),
    )
  }
  return out
}

/** R3.4 `runtime-import`: every runtime import of the source is an exposed module, `react` or the store bridge. A private copy of an app module would split its state. */
function checkImports(source: string, filename: string, appRoot: string, ctx: Context): Diagnostic[] {
  const exposed = exposedByPath(appRoot, ctx.exposed)
  const from = dirname(resolve(appRoot, filename))
  const out: Diagnostic[] = checkImportAttributes(source)
  let imports: { path: string }[]
  try {
    // `scan`, not `scanImports`: the latter adds the JSX runtime import the transpiler would insert. Type-only imports are erased by the parser.
    imports = sourceScanner().scan(source).imports
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
function checkTree(tree: CompiledComponent[], ctx: Context): Diagnostic[] {
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
  // The compiler's own flag (R4.4), not a search of the template text: markup that merely contains `brust_dynamic(` is fine.
  if (tree.some((c) => (JSON.parse(c.ir) as Ir).dynamic === true)) out.push(err('runtime-dynamic', 'contains a <Dynamic> slot: a runtime component cannot place another runtime component', 'place it from a page or layout of the app'))
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

  // F550: nothing of the source may run. A macro import is refused before the compiler and any bundle see the source.
  const macros = checkMacros(source)
  if (macros.length > 0) return { ok: false, diagnostics: macros }
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
  // F520: the facts are of the file as written, so their positions are the caller's own.
  const facts = tree.facts ? (JSON.parse(tree.facts) as Facts) : undefined
  const refuse = (diagnostics: Diagnostic[]): CompileResult => (facts ? { ok: false, diagnostics, facts } : { ok: false, diagnostics })
  if (tree.error) return refuse([...importProblems, rename(fromNapi(tree.error))])
  const diagnostics = [...importProblems, ...tree.components.flatMap((c) => c.diagnostics.map((d) => rename(fromNapi(d))))]
  const root = tree.components[0]!
  // The id is the stem, 16 hex digits and 8 more: a long file name makes an id the registry refuses later.
  if (root.id.length > MAX_ID_LENGTH)
    return refuse([...diagnostics, err('runtime-filename', `the file name "${filename}" makes the component id ${root.id.length} characters long; the limit is ${MAX_ID_LENGTH}`, 'use a shorter file name')])
  const refusals = checkTree(tree.components, ctx).map(rename)
  if (diagnostics.some((d) => d.class === 'error') || refusals.length > 0) return refuse([...diagnostics, ...refusals])

  const client = await bundleClient(tree.components, ctx, { appRoot, filename })
  if (client.problems.length > 0) return refuse([...diagnostics, ...client.problems.map(rename)])
  const sizes: Diagnostic[] = []
  if (bytes(root.jinja) > MAX_JINJA_BYTES) sizes.push(err('runtime-size', `the template is ${bytes(root.jinja)} bytes; the limit is ${MAX_JINJA_BYTES}`, 'split the component or trim its markup'))
  if (client.code !== null && bytes(client.code) > MAX_CLIENT_BYTES) sizes.push(err('runtime-size', `the client module is ${bytes(client.code)} bytes; the limit is ${MAX_CLIENT_BYTES}`, 'import shared code from an exposed module instead of bundling it'))
  if (sizes.length > 0) return refuse([...diagnostics, ...sizes])

  // R3.6: the build's own `featuresOf`, then the store rule the build applies to a chunk that imports the store module. An
  // artifact that reads a store reaches that module through the exposed module that defines it, so it counts too.
  const features: string[] = featuresOf(root.id, root.jinja, false)
  const stores = [...new Set(tree.components.flatMap((c) => ((JSON.parse(c.ir) as Ir).stores ?? []) as { resolved: { name: string } | null }[]).flatMap((s) => (s.resolved ? [s.resolved.name] : [])))].sort()
  const chunk = 'client/runtime-component.js'
  if ((stores.length > 0 || (client.code !== null && importsStore((rel) => (rel === chunk ? client.code! : undefined), chunk, ctx.storeFile))) && !features.includes('store')) features.push('store')
  // The root can be a static shell around a native child: the page needs the runtime whenever there is client code.
  const tier = client.code === null ? 'static' : 'native'
  const artifact: RuntimeArtifact = { v: 1, build: ctx.build, id: root.id, tier, jinja: root.jinja, client: client.code, features, stores }
  return facts ? { ok: true, artifact, diagnostics, facts } : { ok: true, artifact, diagnostics }
}
