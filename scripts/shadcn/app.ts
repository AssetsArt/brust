// App-level survey: every fixture page is built ALONE by the real `brust build` (its own entry, its own dist) and the
// outcome is recorded, never judged. A page that builds is MEASURED: tier per component, islands and client JS come
// from its `dist/manifest.json` and `dist/client`. A page that is refused keeps its refusal (rule, place, construct) and
// the compiler's own `compileTree` analysis, and is ANALYSIS-ONLY.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { compileTree } from '../../packages/brust/native/index.js'
import { readPathAliases } from '../../packages/brust/src/build/tsconfig-paths'
import { FIXTURE, repo } from './paths.ts'

/** The fixture's `tsconfig` `paths` (the CLI writes `@/` imports), as the build hands them to the compiler. */
const ALIASES = JSON.stringify(readPathAliases(FIXTURE).aliases)

export type Tier = 'static' | 'native' | 'react' | 'error'

export interface AppRow {
  /** the route / page name (`pages/<name>.tsx`) */
  id: string
  tier: Tier
  /** the page root's own React reason when it is a React page */
  reason: string | null
  /** distinct `fallback:*` rules over every component the page's tree compiled */
  codes: string[]
  /** React islands the page ships: 1 when the page root is React, else the React components reached through static/native ones */
  islands: number
  /** compiled components in the tree (page + local imports) */
  components: number
  /** how many of them are React tier */
  reactComponents: number
  /** bytes of compiler-emitted client JS (native chunks) over the tree; deterministic */
  clientBytes: number
  /** per blocked component: `Name (file) rule…` for the ranked list */
  blocked: { name: string; file: string; codes: string[] }[]
  build: { ok: true; measured: Measured } | { ok: false; message: string; raw?: string; refusal: Refusal | null }
  /** compile error text when `compileTree` itself refused (an Error diagnostic) */
  error: string | null
}

/** What a built page really is, read from its dist. */
export interface Measured {
  /** the page component's tier in `manifest.json` */
  tier: Exclude<Tier, 'error'>
  /** React islands: walk down from the page through static/native components, count each React one */
  islands: number
  /** components in the manifest, and how many are React */
  components: number
  reactComponents: number
  /** components with a native client chunk */
  nativeChunks: number
  /** client JS the page loads (runtime + the chunks of its islands/native components + the shared chunks they import; 0 when it has none) */
  jsRaw: number
  jsGzip: number
  files: { name: string; raw: number; gzip: number }[]
  /** files of the dist (client chunks and jobs.js) that carry Radix's Slot: an `asChild` page that was resolved at its call site ships none (S1.4 R34.33) */
  slotFiles: string[]
}

/** The build error of a refused page: `error <rule> <file>:<line>:<col> <message>` split into its parts. */
export interface Refusal { rule: string; at: string; construct: string }

type Ir = { tier: unknown; children?: { name: string; id: string | null; path: string | null; tier: unknown }[]; external?: unknown }
const tierName = (t: unknown): Exclude<Tier, 'error'> => (t === 'Static' ? 'static' : t === 'Native' ? 'native' : 'react')
const reasonOf = (t: unknown): string | null => (t && typeof t === 'object' && 'React' in t ? ((t as { React: { reason: string } }).React.reason ?? null) : null)

export const pageNames = (): string[] =>
  readdirSync(join(FIXTURE, 'pages')).filter((f) => f.endsWith('.tsx')).map((f) => f.slice(0, -4)).sort()

export function analysePage(id: string): Omit<AppRow, 'build'> {
  const base = { id, tier: 'error' as Tier, reason: null, codes: [], islands: 0, components: 0, reactComponents: 0, clientBytes: 0, blocked: [], error: null }
  let tree: ReturnType<typeof compileTree>
  try {
    tree = compileTree(`pages/${id}.tsx`, FIXTURE, '/_brust/runtime.js', [], null, null, null, [], ALIASES)
  } catch (e) {
    return { ...base, codes: ['error:compile-throw'], error: String(e instanceof Error ? e.message : e).split('\n')[0]!.replaceAll(FIXTURE, '.') }
  }
  if (tree.error) return { ...base, codes: [`error:${tree.error.rule}`], error: `${tree.error.rule}: ${tree.error.message}` }
  const byId = new Map(tree.components.map((c) => [c.id, { c, ir: JSON.parse(c.ir) as Ir }]))
  const root = tree.components[0]!
  const rootIr = byId.get(root.id)!.ir
  const codes = new Set<string>()
  const blocked: AppRow['blocked'] = []
  let clientBytes = 0
  let reactComponents = 0
  for (const { c, ir } of byId.values()) {
    clientBytes += c.clientJs?.length ?? 0
    if (tierName(ir.tier) === 'react') reactComponents++
    const fb = [...new Set(c.diagnostics.filter((d) => d.class === 'fallback').map((d) => d.rule))].sort()
    for (const r of fb) codes.add(r)
    const own = ir.external ? '' : c.source
    if (fb.length) blocked.push({ name: c.id.replace(/_[0-9a-f]{8}$/, ''), file: own || '(package)', codes: fb })
  }
  // Islands: walk down from the root through static/native components; every React one is an island (not descended into).
  const seen = new Set<string>()
  const walk = (ir: Ir, id: string): number => {
    if (tierName(ir.tier) === 'react') return 1
    if (seen.has(id)) return 0
    seen.add(id)
    return (ir.children ?? []).reduce((n, ch) => {
      const next = ch.id ? byId.get(ch.id) : undefined
      return n + (next ? walk(next.ir, ch.id!) : tierName(ch.tier) === 'react' ? 1 : 0)
    }, 0)
  }
  return {
    ...base,
    tier: tierName(rootIr.tier),
    reason: reasonOf(rootIr.tier),
    codes: [...codes].sort(),
    islands: walk(rootIr, root.id),
    components: byId.size,
    reactComponents,
    clientBytes,
    blocked: blocked.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
    error: null,
  }
}

export interface Repro { id: string; what: string; build: AppRow['build']; codes: string[] }

/** The three-file repro behind the ranked "island component is not a default export" blocker: the same shadcn-shaped
 * component (rest props) exported by name, exported as default, and without rest props (static). */
export function surveyRepro(): Repro[] {
  const cases = [
    { id: 'named', what: '`export function Box({ className, ...props })` in ui.tsx, used by a page' },
    { id: 'default', what: 'the same component as `export default function Box`' },
    { id: 'static', what: '`export function Box({ className })` (no rest props: static, inlined)' },
  ]
  return cases.map((c) => {
    const tree = compileTree(`repro/page-${c.id}.tsx`, FIXTURE, '/_brust/runtime.js', [], null, null, null, [], ALIASES)
    const codes = [...new Set(tree.components.flatMap((x) => x.diagnostics.filter((d) => d.class === 'fallback').map((d) => d.rule)))].sort()
    return { ...c, codes, build: buildEntry(`repro/r-${c.id}.tsx`, `repro-${c.id}`) }
  })
}

/** One page, one `brust build` (its own entry and dist under `.rows/`, both removed after). */
export function buildPage(id: string): AppRow['build'] {
  const dir = join(FIXTURE, '.rows')
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, `${id}.routes.tsx`)
  writeFileSync(entry, `import { defineRoutes } from '@brust/core/routes'\nimport Page from '../pages/${id}'\nexport const routes = defineRoutes([{ path: '/${id}', Component: Page }])\n`)
  try {
    return buildEntry(`.rows/${id}.routes.tsx`, id)
  } finally {
    rmSync(entry, { force: true })
  }
}

type Manifest = {
  routes: { chain: string[] }[]
  components: Record<string, { tier: 'static' | 'native' | 'react'; template: string; client: string | null; children: { id: string }[]; features?: string[] }>
  assets: { runtime: string; features?: Record<string, string> }
}

/** Relative JS imports of a chunk (`from"./x.js"`, `import("./x.js")`). */
const importsOf = (text: string): string[] => [...text.matchAll(/(?:from\s*|import\s*\(\s*)["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]!)

/** What Radix's Slot looks like in a bundle (its identifiers survive minification as property names, and an unbundled import names the package). */
const SLOT_CODE = /Slottable|SlotClone|@radix-ui\/react-slot|radix-ui/

/** Reads a finished dist: tier of the page, islands, native chunks, and the client JS the page loads: the runtime core and
 * the feature modules its components need, plus the chunk of every island and native component the page reaches, plus the shared chunks those import (a React child
 * of an island is rendered by the island, so its own chunk is not loaded). */
export function measureDist(out: string): Measured {
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Manifest
  const root = m.routes[0]!.chain.at(-1)!
  const seen = new Set<string>()
  const entries: string[] = []
  const features = new Set<string>()
  let islands = 0
  let nativeChunks = 0
  // An island instance is a `<brust-island data-id=…>` in a template; static and native components are walked through
  // their templates and their child records.
  const walk = (id: string): void => {
    const c = m.components[id]
    if (!c || seen.has(id)) return
    seen.add(id)
    const template = readFileSync(join(out, c.template), 'utf8')
    for (const f of c.features ?? []) features.add(f)
    if (c.tier !== 'react' && c.client) {
      entries.push(c.client.replace(/^client\//, ''))
      nativeChunks++
    }
    for (const mk of template.matchAll(/<brust-island\b[^>]*\bdata-id="([^"]+)"/g)) {
      islands++
      const isl = m.components[mk[1]!]
      for (const f of isl?.features ?? []) features.add(f)
      if (isl?.client) entries.push(isl.client.replace(/^client\//, ''))
    }
    for (const ch of c.children) if (m.components[ch.id]?.tier !== 'react') walk(ch.id)
  }
  walk(root)
  const client = join(out, 'client')
  const loaded = new Set<string>()
  const visit = (name: string): void => {
    if (loaded.has(name)) return
    loaded.add(name)
    for (const dep of importsOf(readFileSync(join(client, name), 'utf8'))) visit(dep)
  }
  if (entries.length) {
    visit(m.assets.runtime.replace(/^client\//, ''))
    // L33: the runtime feature modules the page preloads (the union over its components and islands, the store module included).
    for (const f of [...features].sort()) if (m.assets.features?.[f]) visit(m.assets.features[f]!.replace(/^client\//, ''))
    for (const e of entries) visit(e)
  }
  const files = [...loaded].sort().map((name) => {
    const buf = readFileSync(join(client, name))
    return { name: name.replace(/-[0-9a-f]{8,12}(?=\.js$)/, ''), raw: buf.length, gzip: gzipSync(buf).length }
  })
  const comps = Object.values(m.components)
  const slotFiles = [...readdirSync(client).filter((f) => f.endsWith('.js')).map((f) => join('client', f)), 'jobs.js']
    .filter((f) => existsSync(join(out, f)) && SLOT_CODE.test(readFileSync(join(out, f), 'utf8')))
    .map((f) => f.replace(/-[0-9a-f]{8,12}(?=\.js$)/, ''))
    .sort()
  return {
    tier: m.components[root]!.tier,
    islands,
    components: comps.length,
    reactComponents: comps.filter((c) => c.tier === 'react').length,
    nativeChunks,
    jsRaw: files.reduce((n, f) => n + f.raw, 0),
    jsGzip: files.reduce((n, f) => n + f.gzip, 0),
    files,
    slotFiles,
  }
}

/** `error island-prop pages/calendar.tsx:31:5 prop \`components\` passed to the React island <DayPicker> is a function` */
export function parseRefusal(text: string): Refusal | null {
  const m = /^error (\S+) (\S+) (.*)$/m.exec(text)
  if (!m) return null
  const prop = /prop `([^`]+)` passed to the React island <([^>]+)>/.exec(m[3]!)
  return { rule: m[1]!, at: m[2]!, construct: prop ? `prop \`${prop[1]}\` on <${prop[2]}>` : m[3]! }
}

/** `brust build <entry>` in the fixture, into a throwaway dist. */
function buildEntry(entryRel: string, id: string): AppRow['build'] {
  const out = join(FIXTURE, '.rows', `dist-${id}`)
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  try {
    const p = spawnSync(process.execPath, [join(repo, 'packages/brust/bin/brust'), 'build', entryRel, '--out-dir', `.rows/dist-${id}`], { cwd: FIXTURE, encoding: 'utf8' })
    if (p.status === 0) return { ok: true, measured: measureDist(out) }
    const text = (p.stderr || p.stdout).replaceAll(FIXTURE, '.')
    const refusal = parseRefusal(text)
    // A bundler failure (no diagnostic code): the island entry could not import its component.
    if (/No matching export in "[^"]+" for import "default"/.test(text)) return { ok: false, message: 'bundle: island component is not a default export', raw: `${text.split('\n').find((l) => /^error /.test(l))} / ${text.split('\n').find((l) => /^BuildMessage/.test(l))}`, refusal: null }
    const line = text.split('\n').find((l) => /^error /.test(l))
    return { ok: false, message: line ? line.replace(/^error /, '') : `exit ${p.status}`, refusal }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

export function surveyApp(): AppRow[] {
  return pageNames().map((id) => ({ ...analysePage(id), build: buildPage(id) }))
}
