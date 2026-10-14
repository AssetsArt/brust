// Compiles every battery row through the real `brustc` and writes the
// deterministic report `docs/react-coverage.md`.
//   bun scripts/battery/run.ts            regenerate the report (exit 1 on an unexplained ⚠)
//   bun scripts/battery/run.ts --check    same, without writing
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CATEGORIES, rows, type Expect, type Row, type StubPackage } from './rows.ts'
import { preparePackageSources } from '../../packages/brust/src/build/pkg-src.ts'
import { renderExitReport } from './exit.ts'
import { coverageJson, renderApiSection } from './api-coverage.ts'

const repo = resolve(import.meta.dir, '../..')
export const REPORT = join(repo, 'docs/react-coverage.md')
export const REPORT_JSON = join(repo, 'docs/react-coverage.json')
export const EXIT_REPORT = join(repo, 'docs/plans/m1-exit-report.md')

/** `ok` = `--emit all` succeeded; `refused` = an `Error` diagnostic refused the build by design; `failed` = anything else (crash, panic, signal). */
export type Build = 'ok' | 'refused' | 'failed'

export interface Result {
  row: Row
  observed: Expect
  jobs: string[]
  diagnostics: string[]
  message?: string
  /** outcome of lowering with `brustc --emit all`; meaningless (and shown as —) when `built` is false */
  build: Build
  buildMessage?: string
  /** false when the row never reached the lowering spawn (`compile-error`) */
  built: boolean
  /** `html_raw` occurrences in the printed templates: the one unescaped sink (`dangerouslySetInnerHTML`) */
  rawSinks: number
  /** expectation not met (tier or job count), and the row is not a known gap */
  warn: boolean
}

export function buildBrustc(): string {
  const r = spawnSync('cargo', ['build', '-q', '-p', 'brust-compiler-cli'], { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.status !== 0) throw new Error('cargo build -p brust-compiler-cli failed')
  return join(process.env.CARGO_TARGET_DIR ?? join(repo, 'target'), 'debug/brustc')
}

type Diag = { class: string; rule: string }
type IR = { tier: string | { React: unknown }; jobs: { kind: string | Record<string, unknown> }[]; diagnostics: Diag[] }

/** Pure: classifies the `--emit all` spawn. An `Error` diagnostic makes `brustc` exit 1 by design (`compile_tree` returns the error). */
export function classifyBuild(status: number | null, stderr: string, hasErrorDiag: boolean): Build {
  if (status === 0) return 'ok'
  // F49: a refusal names its rule on stderr (`error <rule> file:line:col …`); a bare exit 1 is not one.
  if (status === 1 && hasErrorDiag && /^error [a-z-]+ /m.test(stderr) && !/panicked at/.test(stderr)) return 'refused'
  return 'failed'
}

function compile(brustc: string, row: Row): Omit<Result, 'warn'> {
  const dir = mkdtempSync(join(tmpdir(), 'battery-'))
  try {
    writeFileSync(join(dir, 'input.tsx'), row.snippet + '\n')
    for (const [name, text] of Object.entries(row.files ?? {})) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text + '\n')
    }
    const extra: string[] = []
    if (row.packages) {
      for (const [name, pkg] of Object.entries(row.packages)) writeStubPackage(join(dir, 'node_modules', name), name, pkg)
      preparePackageSources(dir, Object.keys(row.packages))
      extra.push('--packages', join(dir, '.brust/pkg-src/index.json'))
    }
    const p = spawnSync(brustc, ['input.tsx', '--emit', 'ir', ...extra], { cwd: dir, encoding: 'utf8' })
    if (p.status !== 0 || !p.stdout.trim().startsWith('{')) {
      // A snippet that does not parse is a result, not a crash.
      const lines = (p.stderr || p.stdout).split('\n').filter((l) => l.trim())
      // A compiler panic names a machine path on its first line: keep the assertion only.
      const message = lines[0]!.includes('panicked')
        ? `compiler panic: ${lines[1] ?? ''}`
        : lines[0]!.replace(/^error:\s*/, '').replaceAll(dir, '.')
      return { row, observed: 'compile-error', jobs: [], diagnostics: [], message, build: 'ok', built: false, rawSinks: 0 }
    }
    const ir = JSON.parse(p.stdout) as IR
    const diagnostics = [...new Set(ir.diagnostics.map((d) => `${d.class.toLowerCase()}:${d.rule}`))]
    const hasError = ir.diagnostics.some((d) => d.class === 'Error')
    const tier = typeof ir.tier === 'string' ? (ir.tier.toLowerCase() as Expect) : 'react'
    const jobs = ir.jobs.map((j) => (typeof j.kind === 'string' ? j.kind : Object.keys(j.kind)[0]!).toLowerCase())
    const b = spawnSync(brustc, ['input.tsx', '--emit', 'all', '--out', join(dir, 'out'), ...extra], { cwd: dir, encoding: 'utf8' })
    const build = classifyBuild(b.status, b.stderr ?? '', hasError)
    const buildMessage = build === 'failed'
      ? ((b.stderr ?? '').split('\n').find((l) => l.trim()) ?? `exit ${b.status}`).replace(/^error:\s*/, '').replaceAll(dir, '.')
      : undefined
    return { row, observed: hasError ? 'error' : tier, jobs, diagnostics, build, buildMessage, built: true, rawSinks: countRawSinks(join(dir, 'out')) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A stub package: `package.json`, the sources, `dist/index.mjs` transpiled from them (the entry source last) and,
 * unless `publish` says otherwise, the source map carrying them. */
function writeStubPackage(dir: string, name: string, pkg: StubPackage): void {
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const paths = Object.keys(pkg.files)
  const t = new Bun.Transpiler({ loader: 'tsx' })
  const built = (files: Record<string, string>) => paths.map((p) => t.transformSync(files[p]!)).join('\n')
  put('package.json', JSON.stringify({ name, version: '1.0.0', exports: { '.': { import: './dist/index.mjs' } }, source: `./${paths[0]}` }))
  for (const p of paths) put(p, pkg.files[p]!)
  // `drift`: the published file was built from a source whose `props` was renamed: a name the map has, the dist lacks.
  const drifted = Object.fromEntries(paths.map((p) => [p, pkg.files[p]!.replaceAll(/\bprops\b/g, 'drifted')]))
  put('dist/index.mjs', built(pkg.publish === 'drift' ? drifted : pkg.files))
  if (pkg.publish !== 'no-map')
    put('dist/index.mjs.map', JSON.stringify({ version: 3, sources: paths.map((p) => `../${p}`), sourcesContent: paths.map((p) => pkg.files[p]), mappings: '' }))
}

/** Every `html_raw` in the `.jinja` files `--emit all` wrote (none when the build was refused). */
function countRawSinks(out: string): number {
  const files = (d: string): string[] => {
    try { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)])) } catch { return [] }
  }
  return files(out).filter((f) => f.endsWith('.jinja')).reduce((n, f) => n + (readFileSync(f, 'utf8').match(/html_raw/g)?.length ?? 0), 0)
}

export function runBattery(): Result[] {
  const brustc = buildBrustc()
  return rows.map((row) => {
    const r = compile(brustc, row)
    const jobMiss = row.jobs !== undefined && row.jobs !== r.jobs.length
    // A crash is never a documented gap; an error row must refuse; a non-error row must not.
    const buildBad = r.built && (r.build === 'failed' || (r.build === 'refused') !== (r.observed === 'error'))
    return { ...r, warn: buildBad || (!row.knownGap && (r.observed !== row.expect || jobMiss)) }
  })
}

const cell = (s: string) => s.replaceAll('|', '\\|')
const buildCell = (r: Result) => (!r.built ? '—' : r.build === 'failed' ? cell(`failed: ${r.buildMessage ?? '?'}`) : r.build)
const jobsCell = (j: string[]) => (j.length ? j.join(', ') : '0')

export function renderReport(results: Result[]): string {
  const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(repo, 'Cargo.toml'), 'utf8'))?.[1] ?? '?'
  const L: string[] = []
  L.push('# React coverage (v2)', '')
  L.push(`Generated by \`bun run battery\` (compiler ${version}); do not edit. Each row is analysed by the real \`brustc --emit ir\` and lowered by \`brustc --emit all\`.`)
  L.push('Expected tiers come from the design spec (§3 tier table, §4.3 hook table, §8.1 diagnostics). `⚠` = observed differs from expected (fails the battery); `known gap` = a documented disagreement.', '')
  L.push('## Summary', '')
  L.push('| Category | Rows | static | native | react | error | compile error | build failed | ⚠ |', '|---|---|---|---|---|---|---|---|---|')
  const total = { n: 0, static: 0, native: 0, react: 0, error: 0, ce: 0, bf: 0, warn: 0 }
  for (const [cat, title] of Object.entries(CATEGORIES)) {
    const rs = results.filter((r) => r.row.category === cat)
    const c = (o: Expect) => rs.filter((r) => r.observed === o).length
    const warn = rs.filter((r) => r.warn).length
    const bf = rs.filter((r) => r.build === 'failed').length
    L.push(`| ${cat} ${title} | ${rs.length} | ${c('static')} | ${c('native')} | ${c('react')} | ${c('error')} | ${c('compile-error')} | ${bf} | ${warn} |`)
    Object.assign(total, {
      n: total.n + rs.length, static: total.static + c('static'), native: total.native + c('native'),
      react: total.react + c('react'), error: total.error + c('error'), ce: total.ce + c('compile-error'), bf: total.bf + bf, warn: total.warn + warn,
    })
  }
  L.push(`| **Total** | ${total.n} | ${total.static} | ${total.native} | ${total.react} | ${total.error} | ${total.ce} | ${total.bf} | ${total.warn} |`, '')
  L.push('## Raw HTML (`dangerouslySetInnerHTML`)', '')
  L.push('`dangerouslySetInnerHTML={{ __html: v }}` works on every tier, with React\'s contract: `v` is the element\'s inner HTML, **unescaped**. The author is responsible for sanitising it; brust does not. `null`/`undefined` paint empty and any other non-string is `String(v)`. Static and native templates print it through the single `html_raw` filter (every other dynamic output stays `| e`); a value that reads state also gets an `x-html` directive that rewrites `innerHTML`. Children next to it, a void element, or an object without `__html` are build errors (React throws on each).', '')
  L.push('## Reserved `x-*` attributes', '')
  L.push('Every attribute whose name starts with `x-` written in component JSX is reserved for brust\'s runtime: it is never printed (static, dynamic or spread), and the build warns `reserved-attr`. Rename it (`data-x-…`) or move the component to React. The compiler emits its own directives itself; runtime-dom binds nothing else.', '')
  for (const [cat, title] of Object.entries(CATEGORIES)) {
    L.push(`## ${cat}. ${title}`, '')
    L.push('| Pattern | Authoring | Expected | Observed tier | Jobs | Build | Diagnostics | Note |', '|---|---|---|---|---|---|---|---|')
    for (const r of results.filter((x) => x.row.category === cat)) {
      const observed = `${r.warn ? '⚠ ' : ''}${r.observed}`
      const note = [r.message ? `compile error: ${r.message}` : '', r.row.note ?? '', r.row.knownGap ? `known gap: ${r.row.knownGap}` : '']
        .filter(Boolean).join('; ')
      L.push(`| ${r.row.id} | ${cell(r.row.authoring)} | ${r.row.expect} | ${observed} | ${jobsCell(r.jobs)} | ${buildCell(r)} | ${cell(r.diagnostics.join(', ') || '—')} | ${cell(note)} |`)
    }
    L.push('')
  }
  L.push(renderApiSection(results))
  return L.join('\n')
}

/** `docs/react-coverage.json`: per react.dev entry its status, rows, observed tiers, diagnostics and a one-line note (R18.3). */
export const renderJson = (results: Result[]): string => `${JSON.stringify(coverageJson(results), null, 2)}\n`

if (import.meta.main) {
  const results = runBattery()
  const report = renderReport(results)
  if (!process.argv.includes('--check')) { writeFileSync(REPORT, report); writeFileSync(REPORT_JSON, renderJson(results)); writeFileSync(EXIT_REPORT, renderExitReport(results)) }
  const bad = results.filter((r) => r.warn)
  for (const r of bad) console.error(`⚠ ${r.row.id}: expected ${r.row.expect}${r.row.jobs !== undefined ? ` (${r.row.jobs} jobs)` : ''}, observed ${r.observed} (${r.jobs.length} jobs) ${r.diagnostics.join(',')}`)
  console.log(`[battery] ${results.length} rows, ${bad.length} unexplained ⚠${process.argv.includes('--check') ? '' : ' -> docs/react-coverage.md, docs/react-coverage.json, docs/plans/m1-exit-report.md'}`)
  process.exit(bad.length ? 1 : 0)
}
