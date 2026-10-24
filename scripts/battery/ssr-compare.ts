// F386 (step 0, measure only): for every battery row that compiles native or static, compare the HTML brust's SERVER paints
// with React's `renderToString` of the same source and the same props, after the explicit normaliser in `ssr-normalise.ts`.
//   bun scripts/battery/ssr-compare.ts [--check] [--json out.json] [rowId ...]
//   --check: exit 1 on a diff or a server refusal that `ssr-allowlist.ts` does not explain (run it on all rows)
// The server side is the real thing: ONE generated app (a route per row, `loader` = the row's props), `brust build` +
// `brust start`, one GET per row. (`brustc --render` is not enough: it renders the root template only, so a child instance's
// job, a build-evaluated `cn(...)`, a context value or a `useId` is missing from it.) A row is SKIPPED, with its reason, when it
// cannot be compared here: it is not native/static, it has an ssr job (a React island / fed child paints through React and
// is not the row's own HTML), it brings stub packages (their own node_modules), or React cannot run its source.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { rows, type Row } from './rows.ts'
import { buildBrustc, writeRowDir } from './run.ts'
import { firstDifference, normalise } from './ssr-normalise.ts'
import { ALLOWED } from './ssr-allowlist.ts'
import { gate } from './ssr-gate.ts'
import { ssrProps } from './ssr-props.ts'

const repo = resolve(import.meta.dir, '../..')
const BRUST = join(repo, 'packages/brust/bin/brust')
const REACT_RENDER = join(import.meta.dir, 'ssr-react.ts')
const PKG = join(repo, 'packages/brust/node_modules')
// Inside packages/brust so `@brust/core` and `react` resolve like they do for every other fixture app; removed afterwards.
const APP = join(repo, 'packages/brust/test/fixtures/.battery-ssr')

type Status = 'same' | 'differ' | 'skip-tier' | 'skip-packages' | 'skip-react' | 'skip-served'
interface Outcome { id: string; status: Status; jobs?: string[]; detail?: string; brust?: string; react?: string }

type IR = { tier: string | { React: unknown }; jobs: { kind: string | Record<string, unknown> }[]; diagnostics: { class: string }[] }
const kindOf = (j: IR['jobs'][number]): string => (typeof j.kind === 'string' ? j.kind : Object.keys(j.kind)[0]!).toLowerCase()

const run = (cmd: string, args: string[], cwd: string) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
const props = ssrProps


/** The bare package names a row's sources import (`react`'s own and relative imports excluded). */
function importedPackages(row: Row): string[] {
  const names = new Set<string>()
  for (const src of [row.snippet, ...Object.values(row.files ?? {})]) {
    for (const m of src.matchAll(/(?:from|import)\s+['"]([^'".][^'"]*)['"]/g)) {
      const spec = m[1]!
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
      if (root !== 'react' && root !== 'react-dom') names.add(root)
    }
  }
  return [...names]
}

/** The repo's installed copy of `name` (bun's isolated store, or packages/brust's own node_modules). */
function installed(name: string): string | undefined {
  const own = join(PKG, name)
  if (existsSync(own)) return realpathSync(own)
  const store = join(repo, 'node_modules/.bun')
  const dir = readdirSync(store).find((d) => d.startsWith(`${name.replace('/', '+')}@`))
  return dir ? join(store, dir, 'node_modules', name) : undefined
}

/** Links what the repo provides for a row's imports into `nm`: installed packages, a `cn` (clsx) stand-in, and `brust/store`. Returns
 *  the imports nothing provides (a compile-only row: `import { Heart } from 'icons'`). */
function linkPackages(nm: string, row: Row): string[] {
  const missing: string[] = []
  for (const name of importedPackages(row)) {
    const dest = join(nm, name)
    if (existsSync(dest)) continue // a stub package the row brings itself
    mkdirSync(dirname(dest), { recursive: true })
    if (name === 'cn') {
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'cn', version: '1.0.0', type: 'module', exports: './index.js' }))
      writeFileSync(join(dest, 'index.js'), "import { clsx } from 'clsx'\nexport const cn = (...a) => clsx(a)\n")
      continue
    }
    if (name === 'brust') {
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'brust', version: '1.0.0', exports: { './store': './store/index.ts', './store/react': './store/react.ts' } }))
      symlinkSync(join(repo, 'packages/brust/src/store'), join(dest, 'store'), 'dir')
      continue
    }
    const real = installed(name)
    if (real) symlinkSync(real, dest, 'dir')
    else missing.push(name)
  }
  // `cn` stands on clsx
  if (importedPackages(row).includes('cn') && !existsSync(join(nm, 'clsx')) && installed('clsx')) symlinkSync(installed('clsx')!, join(nm, 'clsx'), 'dir')
  return missing
}

/** Rows the comparison cannot run, with the reason (not a brust difference). */
const HARNESS_SKIP: Record<string, string> = {
  'd-act': "react 19 exports act only from its test build: a production server cannot import it",
}

/** Phase 1: tier, jobs and React's render of one row (the compile dir is a temp dir; React gets the real react linked in). */
function classify(brustc: string, row: Row): Outcome {
  const id = row.id
  const dir = mkdtempSync(join(tmpdir(), 'ssr-battery-'))
  const reactDir = mkdtempSync(join(tmpdir(), 'ssr-battery-react-'))
  try {
    if (HARNESS_SKIP[id]) return { id, status: 'skip-react', detail: HARNESS_SKIP[id] }
    if (importedPackages(row).includes('brust')) return { id, status: 'skip-react', detail: "a brust/store row: React's useStore needs the request's store snapshot, which the store parity tests cover" }
    const extra = writeRowDir(dir, row)
    const ir = run(brustc, ['input.tsx', '--emit', 'ir', ...extra], dir)
    if (ir.status !== 0 || !ir.stdout.trim().startsWith('{')) return { id, status: 'skip-tier', detail: 'does not compile' }
    const j = JSON.parse(ir.stdout) as IR
    const tier = typeof j.tier === 'string' ? j.tier.toLowerCase() : 'react'
    if (tier !== 'native' && tier !== 'static') return { id, status: 'skip-tier', detail: tier }
    if (j.diagnostics.some((d) => d.class === 'Error')) return { id, status: 'skip-tier', detail: 'error' }
    const jobs = j.jobs.map(kindOf)
    if (row.packages) return { id, status: 'skip-packages', jobs, detail: 'stub packages need their own node_modules (not in the shared app)' }

    cpSync(dir, reactDir, { recursive: true, filter: (s) => !/\/(out|\.brust|node_modules\/react)$/.test(s) })
    mkdirSync(join(reactDir, 'node_modules'), { recursive: true })
    for (const p of ['react', 'react-dom']) symlinkSync(join(PKG, p), join(reactDir, 'node_modules', p), 'dir')
    const missing = linkPackages(join(reactDir, 'node_modules'), row)
    if (missing.length > 0) return { id, status: 'skip-react', jobs, detail: `compile-only row: imports ${missing.map((m) => `'${m}'`).join(', ')}, which the repo does not provide` }
    // A route component also receives `params` and `path` from the server; the reference gets the same props.
    writeFileSync(join(reactDir, 'props.json'), JSON.stringify({ ...props(row), params: {}, path: `/${row.id}` }))
    const rr = run(process.execPath, [REACT_RENDER, join(reactDir, 'input.tsx'), join(reactDir, 'props.json')], reactDir)
    if (rr.status !== 0) return { id, status: 'skip-react', jobs, detail: ((rr.stderr || rr.stdout).split('\n').find((l) => /(^|\s)\w*Error\b|^error:/.test(l)) ?? (rr.stderr || rr.stdout).split('\n').find((l) => l.trim()) ?? `exit ${rr.status}`).replaceAll(tmpdir(), '') }
    return { id, status: 'same', jobs, react: rr.stdout }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(reactDir, { recursive: true, force: true })
  }
}

/** The page body of a served document: the row's HTML (the runtime's own `<script>` tags are normalised away). */
const bodyOf = (html: string): string => /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html

/** Phase 2: build + start the generated app and fetch every row's page. */
async function serve(eligible: Row[], wrapped: Set<string>): Promise<Map<string, string | Error>> {
  rmSync(APP, { recursive: true, force: true })
  mkdirSync(APP, { recursive: true })
  const imports: string[] = []
  const entries: string[] = []
  eligible.forEach((row, i) => {
    const d = join(APP, 'rows', row.id)
    mkdirSync(d, { recursive: true })
    writeRowDir(d, row, false)
    linkPackages(join(APP, 'node_modules'), row)
    // An anonymous default export (memo / forwardRef) is not a route component: a one-line route renders it instead.
    if (wrapped.has(row.id)) writeFileSync(join(d, 'route.tsx'), "import Inner from './input'\nexport default function Route(props: any) { return <Inner {...props} /> }\n")
    imports.push(`import R${i} from './rows/${row.id}/${wrapped.has(row.id) ? 'route' : 'input'}'`)
    entries.push(`  { path: '/${row.id}', Component: R${i}, loader: async () => (${JSON.stringify(props(row))}) },`)
  })
  writeFileSync(join(APP, 'routes.tsx'), `import { defineRoutes } from '@brust/core/routes'\n${imports.join('\n')}\n\nexport const routes = defineRoutes([\n${entries.join('\n')}\n])\n`)
  const b = run(BRUST, ['build', 'routes.tsx'], APP)
  if (b.status !== 0) throw new Error(`brust build failed:\n${(b.stderr || b.stdout).slice(0, 4000)}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = spawn(BRUST, ['start', '--port', '0', '--workers', '2'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    let out = ''
    let err = ''
    await new Promise<void>((ok, bad) => {
      proc.stdout!.on('data', (d: Buffer) => { out += d; if (/\[brust\] ready/.test(out)) ok() })
      proc.stderr!.on('data', (d: Buffer) => { err += d })
      proc.on('exit', () => bad(new Error(`brust start exited before ready:\n${out}${err}`)))
    })
    const base = `http://${/listening on (\S+)/.exec(out)![1]}`
    const pages = new Map<string, string | Error>()
    for (const row of eligible) {
      const res = await fetch(`${base}/${row.id}`)
      pages.set(row.id, res.status === 200 ? await res.text() : new Error(`HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 120)}; server stderr: ${err.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /rror|panick/.test(l)).slice(-2).join(' | ').slice(0, 400)}`))
    }
    return pages
  } finally {
    proc.kill('SIGINT')
    await new Promise((r) => { proc.on('exit', r); setTimeout(() => { proc.kill('SIGKILL'); r(null) }, 5000) })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const ji = args.indexOf('--json')
  const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : undefined
  const check = args.includes('--check')
  const only = new Set(args.filter((a) => a !== '--check'))
  const t0 = Date.now()
  const brustc = buildBrustc()
  const wanted = rows.filter((r) => only.size === 0 || only.has(r.id))
  const classified = wanted.map((r) => ({ row: r, c: classify(brustc, r) }))
  const out: Outcome[] = classified.filter((x) => x.c.react === undefined).map((x) => x.c)
  const eligible = classified.filter((x) => x.c.react !== undefined)
  try {
    // A row the build refuses by name (`route rN`) is not compared; the app is rebuilt without it.
    let live = eligible
    const refused = new Map<string, string>()
    let pages: Map<string, string | Error>
    const wrapped = new Set<string>()
    for (;;) {
      try { pages = await serve(live.map((x) => x.row), wrapped); break } catch (e) {
        const n = /\(route r(\d+)\)/.exec(String(e))?.[1]
        if (n !== undefined && /is not the default export/.test(String(e)) && !wrapped.has(live[Number(n)]!.row.id)) { wrapped.add(live[Number(n)]!.row.id); continue }
        // The server validates every template at boot: it names the component (`render lProvider_<hash>…`), the row that declares it.
        const comp = /render (\w+?)_[0-9a-f]{8}/.exec(String(e))?.[1]
        // A worker that cannot import a row's module (`Export named 'act' not found`) names the export, not the row.
        const exp = /Export named '(\w+)' not found/.exec(String(e))?.[1]
        // A path in the message (`.battery-ssr/rows/<id>/els.tsx`) names the row outright.
        const byPath = /\/rows\/([^/\s]+)\//.exec(String(e))?.[1]
        const bad = n !== undefined ? live[Number(n)] : byPath ? live.find((x) => x.row.id === byPath) : exp ? live.find((x) => new RegExp(`import \\{[^}]*\\b${exp}\\b`).test(x.row.snippet)) : comp ? live.find((x) => x.row.snippet.toLowerCase().includes(comp.toLowerCase())) : undefined
        if (!bad) throw e
        refused.set(bad.row.id, (n !== undefined ? String(e).split('\n')[1] : String(e).split('\n').find((l) => /\[brust\] (render|worker)/.test(l))) ?? 'refused')
        live = live.filter((x) => x !== bad)
      }
    }
    for (const [id, why] of refused) out.push({ id, status: 'skip-served', detail: `the server refused it: ${why}` })
    for (const { row, c } of live) {
      const page = pages.get(row.id)!
      if (page instanceof Error) { out.push({ id: row.id, status: 'skip-served', jobs: c.jobs, detail: page.message }); continue }
      const brust = bodyOf(page)
      const d = firstDifference(normalise(brust), normalise(c.react!))
      out.push(d ? { id: row.id, status: 'differ', jobs: c.jobs, detail: d, brust, react: c.react } : { id: row.id, status: 'same', jobs: c.jobs })
    }
  } finally {
    rmSync(APP, { recursive: true, force: true })
  }
  const by = (s: Status) => out.filter((o) => o.status === s)
  console.log(`[ssr-compare] ${out.length} rows: ${by('same').length} same, ${by('differ').length} differ; skipped: ${by('skip-tier').length} tier, ${by('skip-packages').length} packages, ${by('skip-react').length} react, ${by('skip-served').length} served`)
  for (const o of by('differ').slice(0, 20)) console.log(`\nDIFF ${o.id}\n  ${o.detail}`)
  for (const o of [...by('skip-react'), ...by('skip-served')]) console.log(`\n${o.status.toUpperCase()} ${o.id}: ${o.detail}`)
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1))
  if (check) {
    const problems = gate(out, ALLOWED)
    console.log(`\n[ssr-compare] ${problems.length === 0 ? 'ok' : `${problems.length} problem(s)`} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${Object.keys(ALLOWED).length} allowlisted)`)
    for (const p of problems) console.error(`\nSSR GATE: ${p}`)
    if (problems.length > 0) process.exit(1)
  }
}

if (import.meta.main) await main()
