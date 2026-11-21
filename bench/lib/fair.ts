// bench/lib/fair.ts — F595: one fair run or one worker sweep as data (repeated cells, their medians and marks) and as
// Markdown. Pure: the runner collects the runs, this module aggregates and renders. Numbers and marks only; the method
// and how to read it are in bench/README.md.
import type { AppId } from './app'
import type { Encoding, OhaNums } from './oha'
import { PROBES, type ProbeId, probe as probeOf } from './probes'
import type { Machine, Measurement, Results } from './report'
import { balanceRatio, bestN, generatorLimited, noisy, type Spread, spreadOf, type SweepPoint, unbalanced } from './stats'

export interface CellKey { app: AppId; probe: ProbeId; enc: Encoding; conn: number; /** sweep: the process / worker count */ n: number }
export interface CellRun {
  round: number
  nums: OhaNums
  /** generator CPU share of its cores (0..1), null = not measured */
  gen: number | null
  /** per-process CPU seconds of a multi-process app during the run, [] = one process or not measured */
  procCpu: number[]
}
export type Mark = 'noisy' | 'generator-limited' | 'unbalanced' | 'not compressed'
export interface Cell {
  key: CellKey
  runs: CellRun[]
  rps: Spread
  p50: number
  p99: Spread
  bytes: number
  /** the highest generator share of the runs, null = not measured */
  gen: number | null
  /** the worst busiest / idlest ratio of the runs, null = one process or not measured */
  balance: number | null
  marks: Mark[]
}
/** What each app does for a probe, measured before the load (AMENDMENT 1): cache / render, hydration, compression. */
export interface Work { app: AppId; probe: ProbeId; work: string; compressed: boolean | null; bytes: number }
export interface Header {
  kind: 'run' | 'sweep'
  date: string
  machine: Machine
  os: string
  cores: number
  /** logical CPUs of the servers / of the load generator; null = could not pin (ratios only) */
  serverCpus: number[] | null
  genCpus: number[] | null
  versions: Record<string, string>
  sha: string
  seed: number
  rounds: number
  dur: string
  warmup: string
  conns: number[]
  /** process / worker count per app (the run's N, or the sweep's list) */
  budgets: Record<string, string>
  /** what the runtimes would pick inside the server set: brust's default --workers and tokio threads */
  defaults: { brustWorkers: number | null; tokioThreads: number | null }
  estimateMin: number
  tookMin: number | null
  skipped: { app: AppId; reason: string }[]
}
export interface FairResults { header: Header; work: Work[]; cells: Cell[] }

export function aggregate(key: CellKey, runs: CellRun[], compressed: boolean | null): Cell {
  if (runs.length === 0) throw new Error(`no runs for ${key.app} ${key.probe}`)
  const rps = spreadOf(runs.map((r) => r.nums.rps))
  const p99 = spreadOf(runs.map((r) => r.nums.p99))
  const gens = runs.map((r) => r.gen).filter((g): g is number => g !== null)
  const gen = gens.length ? Math.max(...gens) : null
  // With fewer than 4 connections per process the kernel's port hash leaves copies idle by design: the ratio is shown,
  // the mark only applies where every copy can get work.
  const ratios = runs.filter((r) => r.procCpu.length > 1).map((r) => balanceRatio(r.procCpu))
  const markable = runs.every((r) => r.procCpu.length <= 1 || key.conn >= 4 * r.procCpu.length)
  const balance = ratios.length ? Math.max(...ratios) : null
  const marks: Mark[] = []
  if (noisy(rps)) marks.push('noisy')
  if (gen !== null && generatorLimited(gen)) marks.push('generator-limited')
  if (balance !== null && markable && unbalanced(balance)) marks.push('unbalanced')
  if (key.enc === 'gzip' && compressed === false) marks.push('not compressed')
  const med = (f: (r: CellRun) => number) => spreadOf(runs.map(f)).median
  return { key, runs, rps, p50: med((r) => r.nums.p50), p99, bytes: med((r) => r.nums.bytes), gen, balance, marks }
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const ms = (n: number) => (n < 1 ? n.toFixed(3) : n.toFixed(2))
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)
const cpus = (xs: number[] | null) => (xs === null ? 'unpinned' : xs.join(','))

/** D4: apps whose bodies for one probe differ by more than 10% from the smallest. */
export function bodyNote(work: Work[], probe: ProbeId): string | null {
  const rows = work.filter((w) => w.probe === probe && w.bytes > 0)
  if (rows.length < 2) return null
  const min = Math.min(...rows.map((w) => w.bytes))
  const big = rows.filter((w) => w.bytes > min * 1.1)
  return big.length === 0 ? null : `bodies differ by more than 10%: ${rows.map((w) => `${w.app} ${int(w.bytes)} B`).join(', ')} (identity).`
}

/** Like-with-like ratios at the highest connection count, identity, from medians; a side marked generator-limited or
 * unbalanced is named next to the ratio instead of hidden. */
export function verdicts(r: FairResults): string[] {
  const top = Math.max(...r.header.conns)
  const cell = (app: AppId, probe: ProbeId, conn = top) => r.cells.find((c) => c.key.app === app && c.key.probe === probe && c.key.enc === 'identity' && c.key.conn === conn)
  const line = (label: string, a: AppId, b: AppId, probe: ProbeId, conn = top): string | null => {
    const x = cell(a, probe, conn)
    const y = cell(b, probe, conn)
    if (!x || !y) return null
    const marks = [...new Set([...x.marks.map((m) => `${a} ${m}`), ...y.marks.map((m) => `${b} ${m}`)])]
    return `${label.padEnd(20)} ${probe.padEnd(8)} c=${conn}  ${a} / ${b} = ${(x.rps.median / y.rps.median).toFixed(2)}${marks.length ? `  (${marks.join('; ')})` : ''}`
  }
  const out: (string | null)[] = []
  // both serve a cached page
  out.push(line('cached page', 'brust', 'next', 'S'))
  // all render per request
  for (const p of ['S-render', 'D'] as ProbeId[]) out.push(line('render per request', 'brust', 'bun-serve', p))
  for (const p of ['D', 'I'] as ProbeId[]) out.push(line('render per request', 'brust', 'next', p))
  for (const p of ['A1', 'A2'] as ProbeId[]) for (const c of r.header.conns) out.push(line('action', 'brust', 'elysia-bun', p, c))
  return out.filter((x): x is string => x !== null)
}

export function renderRun(r: FairResults): string {
  const h = r.header
  const L: string[] = [
    `# bench ${h.kind} — ${h.date}`,
    '',
    `${h.machine.model} · ${h.machine.chip} · ${h.machine.memGb} GB · ${h.cores} logical CPUs · ${h.os}`,
    `server CPUs ${cpus(h.serverCpus)} · generator CPUs ${cpus(h.genCpus)}${h.serverCpus === null ? ' · unpinned: ratios only' : ''}`,
    `brust ${h.sha} · ${Object.entries(h.versions).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    `budgets ${Object.entries(h.budgets).map(([k, v]) => `${k} ${v}`).join(', ')} · in the server set brust would default to ${h.defaults.brustWorkers ?? '?'} workers and ${h.defaults.tokioThreads ?? '?'} tokio threads (left at their default)`,
    `${h.rounds} rounds, interleaved, seed ${h.seed} · \`oha -z ${h.dur}\` at c=${h.conns.join(' and c=')} · warm-up ${h.warmup} discarded per cell · load minutes planned ${h.estimateMin}, taken ${h.tookMin ?? '—'}`,
  ]
  if (h.skipped.length) L.push(`skipped: ${h.skipped.map((s) => `${s.app} (${s.reason})`).join(', ')}`)
  L.push('', 'Cells show the median of the rounds and [min-max]. Marks: noisy = (max-min)/median > 5%; generator-limited = oha used >= 90% of its CPUs (the number is the generator\'s ceiling); unbalanced = busiest / idlest process > 2:1 (only at 4+ connections per process); not compressed = the gzip request got an identity body.')
  for (const p of PROBES) {
    const cells = r.cells.filter((c) => c.key.probe === p.id)
    if (cells.length === 0) continue
    L.push('', `## ${p.id} — \`${p.method} ${p.path}\``, '', p.what, '')
    const work = r.work.filter((w) => w.probe === p.id)
    if (work.length) L.push(`work: ${work.map((w) => `${w.app} ${w.work}`).join(' · ')}`, '')
    L.push(`| app | ${h.kind === 'sweep' ? 'N | ' : ''}c | enc | rps median [min-max] | p50 ms | p99 ms [min-max] | bytes/resp | gen CPU | balance | marks |`)
    L.push(`|---|${h.kind === 'sweep' ? '---:|' : ''}---:|---|---:|---:|---:|---:|---:|---:|---|`)
    const sorted = [...cells].sort((a, b) => a.key.app.localeCompare(b.key.app) || a.key.n - b.key.n || b.key.conn - a.key.conn || a.key.enc.localeCompare(b.key.enc))
    for (const c of sorted)
      L.push(`| ${c.key.app} | ${h.kind === 'sweep' ? `${c.key.n} | ` : ''}${c.key.conn} | ${c.key.enc} | ${int(c.rps.median)} [${int(c.rps.min)}-${int(c.rps.max)}] | ${ms(c.p50)} | ${ms(c.p99.median)} [${ms(c.p99.min)}-${ms(c.p99.max)}] | ${int(c.bytes)} | ${pct(c.gen)} | ${c.balance === null ? '—' : `${c.balance.toFixed(2)}:1`} | ${c.marks.join(', ')} |`)
    const note = bodyNote(r.work, p.id)
    if (note) L.push('', note)
  }
  if (h.kind === 'sweep') L.push(...renderSweep(r))
  else {
    const v = verdicts(r)
    if (v.length) L.push('', '## Like with like', '', '```', ...v, '```')
  }
  const marked = r.cells.filter((c) => c.marks.length)
  L.push('', '## Marked cells', '', marked.length ? marked.map((c) => `- ${c.key.app} ${c.key.probe}${h.kind === 'sweep' ? ` N=${c.key.n}` : ''} c=${c.key.conn} ${c.key.enc}: ${c.marks.join(', ')}`).join('\n') : 'none')
  L.push('', 'Generated by `bun run bench` (`bench/run.ts`); method in `bench/README.md`.', '')
  return L.join('\n')
}

/** D7: per (app, probe) the sweep's median rps and p99 per N and the best N. */
export function sweepTable(r: FairResults): { app: AppId; probe: ProbeId; points: SweepPoint[]; best: SweepPoint | null }[] {
  const keys = [...new Set(r.cells.map((c) => `${c.key.app}|${c.key.probe}`))]
  return keys.map((k) => {
    const [app, probe] = k.split('|') as [AppId, ProbeId]
    const points = r.cells
      .filter((c) => c.key.app === app && c.key.probe === probe && c.key.enc === 'identity')
      .map((c) => ({ n: c.key.n, rps: c.rps.median, p99: c.p99.median }))
      .sort((a, b) => a.n - b.n)
    return { app, probe, points, best: bestN(points) }
  })
}

function renderSweep(r: FairResults): string[] {
  const def = r.header.defaults.brustWorkers
  const L = ['', '## Best N (highest median rps whose p99 is within 20% of the best p99)', '', '| app | probe | best N | rps | p99 ms | brust default N |', '|---|---|---:|---:|---:|---:|']
  for (const t of sweepTable(r)) L.push(`| ${t.app} | ${t.probe} | ${t.best?.n ?? '—'} | ${t.best ? int(t.best.rps) : '—'} | ${t.best ? ms(t.best.p99) : '—'} | ${t.app === 'brust' ? (def ?? '?') : '—'} |`)
  return L
}

/** `--publish`: the medians in the format bench/RESULTS.json has always had (the website and scripts/m2-exit read it). */
export function legacyResults(r: FairResults): Results {
  const h = r.header
  const top = Math.max(...h.conns)
  const toM = (c: Cell, withConn: boolean): Measurement => ({
    app: c.key.app,
    probe: c.key.probe,
    enc: c.key.enc,
    nums: { rps: c.rps.median, p50: c.p50, p95: spreadOf(c.runs.map((x) => x.nums.p95)).median, p99: c.p99.median, total: spreadOf(c.runs.map((x) => x.nums.total)).median, errors: 0, status: { '200': spreadOf(c.runs.map((x) => x.nums.total)).median }, bytes: c.bytes },
    raw: null,
    ...(withConn ? { conn: c.key.conn } : {}),
  })
  const page = r.cells.filter((c) => probeOf(c.key.probe).kind === 'page' && c.key.conn === top)
  const json = r.cells.filter((c) => probeOf(c.key.probe).kind === 'json')
  const host = h.os
  const base = { date: h.date, host, machine: h.machine, cores: h.cores, loadavg: [], seed: h.seed, dur: h.dur, warmup: h.warmup, settleMs: 0, workers: Number.parseInt(Object.values(h.budgets)[0]?.replace(/\D+/g, '') ?? '0', 10), versions: h.versions, skipped: h.skipped, order: [] as string[], budgets: h.budgets }
  const pageApps = [...new Set(page.map((c) => c.key.app))]
  const jsonApps = [...new Set(json.map((c) => c.key.app))]
  return {
    header: { ...base, conn: top, apps: pageApps, bunServeBalanced: page.some((c) => c.key.app === 'bun-serve') ? !page.some((c) => c.key.app === 'bun-serve' && c.marks.includes('unbalanced')) : null },
    measurements: page.map((c) => toM(c, false)),
    ...(json.length ? { actions: { header: { ...base, conns: h.conns, apps: jsonApps, elysiaBunBalanced: json.some((c) => c.key.app === 'elysia-bun') ? !json.some((c) => c.key.app === 'elysia-bun' && c.marks.includes('unbalanced')) : null }, measurements: json.map((c) => toM(c, true)) } } : {}),
  }
}
