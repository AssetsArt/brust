// App-level survey: every fixture page goes through the compiler (`compileTree`, the call `brust build` makes per
// route) and then through the real `brust build`, one page per build. Both are recorded, never judged: a row's tier
// is whatever the compiler says, a failed build is a result.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileTree } from '../../packages/brust/native/index.js'
import { FIXTURE, repo } from './paths.ts'

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
  build: { ok: true } | { ok: false; message: string; raw?: string }
  /** island bundle bytes (`dist/client/*.js`) when the build worked; measured by the bundler, so NOT written to the doc */
  bundleBytes: number | null
  /** compile error text when `compileTree` itself refused (an Error diagnostic) */
  error: string | null
}

type Ir = { tier: unknown; children?: { name: string; id: string | null; path: string | null; tier: unknown }[]; external?: unknown }
const tierName = (t: unknown): Exclude<Tier, 'error'> => (t === 'Static' ? 'static' : t === 'Native' ? 'native' : 'react')
const reasonOf = (t: unknown): string | null => (t && typeof t === 'object' && 'React' in t ? ((t as { React: { reason: string } }).React.reason ?? null) : null)

export const pageNames = (): string[] =>
  readdirSync(join(FIXTURE, 'pages')).filter((f) => f.endsWith('.tsx')).map((f) => f.slice(0, -4)).sort()

export function analysePage(id: string): Omit<AppRow, 'build' | 'bundleBytes'> {
  const base = { id, tier: 'error' as Tier, reason: null, codes: [], islands: 0, components: 0, reactComponents: 0, clientBytes: 0, blocked: [], error: null }
  let tree: ReturnType<typeof compileTree>
  try {
    tree = compileTree(`pages/${id}.tsx`, FIXTURE, '/_brust/runtime.js', [])
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
    const tree = compileTree(`repro/page-${c.id}.tsx`, FIXTURE, '/_brust/runtime.js', [])
    const codes = [...new Set(tree.components.flatMap((x) => x.diagnostics.filter((d) => d.class === 'fallback').map((d) => d.rule)))].sort()
    return { ...c, codes, build: buildEntry(`repro/r-${c.id}.tsx`, `repro-${c.id}`).build }
  })
}

/** One page, one `brust build` (its own entry and dist under `.rows/`, both removed after). */
export function buildPage(id: string): { build: AppRow['build']; bundleBytes: number | null } {
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

/** `brust build <entry>` in the fixture, into a throwaway dist. */
function buildEntry(entryRel: string, id: string): { build: AppRow['build']; bundleBytes: number | null } {
  const out = join(FIXTURE, '.rows', `dist-${id}`)
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  try {
    const p = spawnSync(process.execPath, [join(repo, 'packages/brust/bin/brust'), 'build', entryRel, '--out-dir', `.rows/dist-${id}`], { cwd: FIXTURE, encoding: 'utf8' })
    if (p.status === 0) {
      const client = join(out, 'client')
      const bytes = readdirSync(client).filter((f) => f.endsWith('.js')).reduce((n, f) => n + Bun.file(join(client, f)).size, 0)
      return { build: { ok: true }, bundleBytes: bytes }
    }
    const text = (p.stderr || p.stdout).replaceAll(FIXTURE, '.')
    // The bundler wants `export default` for a React island's component file; shadcn files export by name.
    if (/No matching export in "[^"]+" for import "default"/.test(text)) return { build: { ok: false, message: 'bundle: island component is not a default export', raw: `${text.split('\n').find((l) => /^error /.test(l))} / ${text.split('\n').find((l) => /^BuildMessage/.test(l))}` }, bundleBytes: null }
    const line = text.split('\n').find((l) => /^error /.test(l))
    return { build: { ok: false, message: line ? line.replace(/^error /, '') : `exit ${p.status}` }, bundleBytes: null }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

export function surveyApp(): AppRow[] {
  return pageNames().map((id) => ({ ...analysePage(id), ...buildPage(id) }))
}
