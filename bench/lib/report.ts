// bench/lib/report.ts — RESULTS.json (raw) + RESULTS.md (header, one table per probe, computed verdict block).
// No prose is generated here: the method lives in bench/README.md (spec §1.5).
import { join } from 'node:path'
import type { AppId } from './app'
import type { Encoding, OhaNums } from './oha'
import { PROBES, type ProbeId } from './probes'

export interface Measurement { app: AppId; probe: ProbeId; enc: Encoding; nums: OhaNums; raw: unknown; /** A rows: the oha connection count; page rows omit it (= the header's `conn`). */ conn?: number }
/** `MacBook Pro · Apple M1 Pro · 16 GB · 10 cores · darwin/arm64`, or just `host <platform/arch>` for results without a machine block. */
function machineLine(h: { host: string; machine?: Machine; cores: number }): string {
  return h.machine ? `${h.machine.model} · ${h.machine.chip} · ${h.machine.memGb} GB · ${h.cores} cores · ${h.host}` : `host ${h.host}`
}
export interface Machine { model: string; chip: string; memGb: number }
export interface Header {
  date: string; host: string; /** model/chip/RAM of the measuring machine (never the hostname) */ machine?: Machine; cores: number; loadavg: number[]; seed: number; conn: number; dur: string; warmup: string; settleMs: number; workers: number
  versions: Record<string, string>; apps: AppId[]; skipped: { app: AppId; reason: string }[]; order: string[]
  /** process budget per app, e.g. 'brust workers=10', 'next procs=1 (as shipped)' */
  budgets: Record<string, string>
  /** bun-serve reusePort balance verdict: true = every copy served >= 5%, false = 1-proc, null = not run */
  bunServeBalanced: boolean | null
}
/** The A1/A2 block (R4): a separate header, because an A-only run has no page header of its own to share. */
export interface ActionsHeader {
  date: string; host: string; /** model/chip/RAM of the measuring machine (never the hostname) */ machine?: Machine; cores: number; loadavg: number[]; seed: number; conns: number[]; dur: string; warmup: string; settleMs: number; workers: number
  versions: Record<string, string>; apps: AppId[]; skipped: { app: AppId; reason: string }[]; order: string[]; budgets: Record<string, string>
  /** elysia-bun reusePort balance verdict: true = every copy served >= 5%, false = 1-proc, null = not run */
  elysiaBunBalanced: boolean | null
}
export interface Results { header: Header; measurements: Measurement[]; actions?: { header: ActionsHeader; measurements: Measurement[] } }
export interface Verdict {
  f68: { d: number | null; i: number | null; met: boolean | null }
  sanity: { s: number | null; d: number | null; i: number | null; met: boolean | null }
  ceiling: { d: number | null; i: number | null; basis: 'equal-budget' | '1-proc' }
}

export const APP_LABEL: Record<AppId, string> = { brust: 'brust', 'bun-serve': 'bun-serve', next: 'next', 'brust-01x': 'brust-01x', 'elysia-bun': 'elysia-bun' }

/** Display names in the Actions section: the brust row there is Elysia 2 served by brust (page rows stay `brust`). */
export const ACTIONS_LABEL: Record<AppId, string> = { ...APP_LABEL, brust: 'elysia-brust' }

export function rpsOf(r: Results, app: AppId, probe: ProbeId, enc: Encoding = 'identity'): number | null {
  const m = r.measurements.find((x) => x.app === app && x.probe === probe && x.enc === enc)
  return m ? m.nums.rps : null
}
const pct = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : ((a - b) / b) * 100)
const ratio = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : a / b)
const share = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : (a / b) * 100)
const allOf = (xs: (number | null)[], ok: (n: number) => boolean): boolean | null => (xs.some((x) => x === null) ? null : xs.every((x) => ok(x as number)))

export function computeVerdict(r: Results): Verdict {
  const v2 = (p: ProbeId) => rpsOf(r, 'brust', p)
  const f68d = pct(v2('D'), rpsOf(r, 'brust-01x', 'D'))
  const f68i = pct(v2('I'), rpsOf(r, 'brust-01x', 'I'))
  const s = ratio(v2('S'), rpsOf(r, 'next', 'S'))
  const d = ratio(v2('D'), rpsOf(r, 'next', 'D'))
  const i = ratio(v2('I'), rpsOf(r, 'next', 'I'))
  return {
    f68: { d: f68d, i: f68i, met: allOf([f68d, f68i], (n) => n >= 0) },
    sanity: { s, d, i, met: allOf([s, d, i], (n) => n >= 2) },
    ceiling: { d: share(v2('D'), rpsOf(r, 'bun-serve', 'D')), i: share(v2('I'), rpsOf(r, 'bun-serve', 'I')), basis: r.header.bunServeBalanced === false ? '1-proc' : 'equal-budget' },
  }
}

const signed = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(1)}%`)
const times = (n: number | null) => (n === null ? '×—' : `×${n.toFixed(1)}`)
const percent = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
const met = (m: boolean | null, suffix = '') => (m === null ? `NOT MEASURED${suffix}` : m ? `MET${suffix}` : `NOT MET${suffix}`)

export function renderVerdict(v: Verdict): string {
  return [
    `bar F68  : v2 vs 0.1.x  D ${signed(v.f68.d)}  I ${signed(v.f68.i)}   → ${met(v.f68.met)}`,
    `sanity   : v2 vs next   S ${times(v.sanity.s)}  D ${times(v.sanity.d)}  I ${times(v.sanity.i)}   → ${met(v.sanity.met, ' (≥ 2×)')}`,
    `ceiling  : v2 / bun-serve${v.ceiling.basis === '1-proc' ? ' (1-proc: reusePort did not balance)' : ''}  D ${percent(v.ceiling.d)}  I ${percent(v.ceiling.i)}        (target D ≥ 80%)`,
  ].join('\n')
}

export interface ActionsVerdict {
  /** brust / elysia-bun rps at the high connection count, percent */
  share: { A1: number | null; A2: number | null }
  /** c=1 p50 brust − elysia-bun, microseconds */
  p50Delta: { A1: number | null; A2: number | null }
  balanced: boolean | null
}
const aRow = (r: Results, app: AppId, probe: ProbeId, high: boolean): Measurement | undefined => {
  const rows = (r.actions?.measurements ?? []).filter((m) => m.app === app && m.probe === probe && m.enc === 'identity')
  return high ? rows.filter((m) => (m.conn ?? 0) > 1).sort((a, b) => (b.conn ?? 0) - (a.conn ?? 0))[0] : rows.find((m) => m.conn === 1)
}
export function computeActionsVerdict(r: Results): ActionsVerdict {
  const per = (probe: 'A1' | 'A2') => ({
    share: share(aRow(r, 'brust', probe, true)?.nums.rps ?? null, aRow(r, 'elysia-bun', probe, true)?.nums.rps ?? null),
    delta: ((a, b) => (a === undefined || b === undefined ? null : (a.nums.p50 - b.nums.p50) * 1000))(aRow(r, 'brust', probe, false), aRow(r, 'elysia-bun', probe, false)),
  })
  const a1 = per('A1')
  const a2 = per('A2')
  return { share: { A1: a1.share, A2: a2.share }, p50Delta: { A1: a1.delta, A2: a2.delta }, balanced: r.actions?.header.elysiaBunBalanced ?? null }
}
const micros = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : '-'}${Math.abs(Math.round(n))} µs`)
export function renderActionsVerdict(v: ActionsVerdict): string {
  return `actions  : elysia-brust / elysia-bun${v.balanced === false ? ' (1-proc: reusePort did not balance)' : ''} (c=120)  A1 ${percent(v.share.A1)}  A2 ${percent(v.share.A2)}   · c=1 p50 elysia-brust − elysia-bun  A1 ${micros(v.p50Delta.A1)}  A2 ${micros(v.p50Delta.A2)}`
}

/** What a run replaces in RESULTS.json (R4): the page block (header + measurements) and/or the actions block. */
export function mergeResults(old: Results | undefined, run: Results, measured: { page: boolean; actions: boolean }): Results {
  const page = measured.page ? { header: run.header, measurements: run.measurements } : old ? { header: old.header, measurements: old.measurements } : { header: run.header, measurements: [] }
  const actions = measured.actions ? run.actions : old?.actions
  return { ...page, ...(actions ? { actions } : {}) }
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const ms = (n: number) => n.toFixed(2)
const ms3 = (n: number) => n.toFixed(3)

export function renderMarkdown(r: Results): string {
  const h = r.header
  const versions = Object.entries(h.versions).map(([k, v]) => `${k} ${v}`).join(' · ')
  const lines: string[] = [
    `# bench — ${h.date}`,
    '',
    `${machineLine(h)} · ${versions} · seed ${h.seed} · \`oha -c ${h.conn} -z ${h.dur}\` · settle ${h.settleMs} ms + warm-up ${h.warmup} discarded · budgets ${Object.entries(h.budgets).map(([k, v]) => `${k} ${v}`).join(', ')} · load ${h.loadavg.map((n) => n.toFixed(1)).join(' ')} (${h.cores} cores) · order ${h.order.join(' ')}`,
  ]
  if (h.skipped.length) lines.push('', `skipped: ${h.skipped.map((s) => `${s.app} (${s.reason})`).join(', ')}`)
  for (const p of PROBES.filter((x) => x.kind === 'page')) {
    lines.push('', `## ${p.id} — \`${p.path}\``, '', '| app | rps | p50 ms | p95 ms | p99 ms | errors | bytes/resp | gzip rps | gzip p50 | gzip p99 | gzip bytes/resp |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const app of h.apps) {
      const id = r.measurements.find((m) => m.app === app && m.probe === p.id && m.enc === 'identity')
      if (!id) continue
      const gz = r.measurements.find((m) => m.app === app && m.probe === p.id && m.enc === 'gzip')
      lines.push(`| ${APP_LABEL[app]} | ${int(id.nums.rps)} | ${ms(id.nums.p50)} | ${ms(id.nums.p95)} | ${ms(id.nums.p99)} | ${id.nums.errors} | ${int(id.nums.bytes)} | ${gz ? int(gz.nums.rps) : '—'} | ${gz ? ms(gz.nums.p50) : '—'} | ${gz ? ms(gz.nums.p99) : '—'} | ${gz ? int(gz.nums.bytes) : '—'} |`)
    }
  }
  lines.push('', '```', renderVerdict(computeVerdict(r)), '```')
  if (r.actions) lines.push(...renderActionsSection(r.actions))
  lines.push('', 'Generated by `bun run bench` (`bench/run.ts`) from `RESULTS.json`; method and reading guide in `bench/README.md`.', '')
  return lines.join('\n')
}

function renderActionsSection(a: NonNullable<Results['actions']>): string[] {
  const h = a.header
  const versions = Object.entries(h.versions).map(([k, v]) => `${k} ${v}`).join(' · ')
  const lines = [
    '', '## Actions', '',
    `${machineLine(h)} · ${versions} · seed ${h.seed} · \`oha -c ${h.conns.join(' / ')} -z ${h.dur}\`, identity only · settle ${h.settleMs} ms + warm-up ${h.warmup} discarded per row · budgets ${Object.entries(h.budgets).map(([k, v]) => `${k} ${v}`).join(', ')} · load ${h.loadavg.map((n) => n.toFixed(1)).join(' ')} (${h.cores} cores) · order ${h.order.join(' ')}`,
    '',
    `elysia-bun reusePort balance: ${h.elysiaBunBalanced === null ? 'not measured' : h.elysiaBunBalanced ? 'balanced across the copies' : '1-proc (the load landed on one copy)'}. macOS does not balance SO_REUSEPORT, so on this host the elysia-bun row is in practice a single-process measurement; read it against elysia-brust's ${h.workers} workers + tokio threads accordingly.`,
  ]
  for (const p of PROBES.filter((x) => x.kind === 'json')) {
    lines.push('', `### ${p.id} — \`${p.method} ${p.path}\``, '', '| app | conn | rps | p50 ms | p95 ms | p99 ms | errors | bytes/resp |', '|---|---:|---:|---:|---:|---:|---:|---:|')
    for (const app of h.apps) {
      for (const m of a.measurements.filter((x) => x.app === app && x.probe === p.id).sort((x, y) => (y.conn ?? 0) - (x.conn ?? 0)))
        lines.push(`| ${ACTIONS_LABEL[app]} | c=${m.conn ?? '—'} | ${int(m.nums.rps)} | ${ms3(m.nums.p50)} | ${ms3(m.nums.p95)} | ${ms3(m.nums.p99)} | ${m.nums.errors} | ${int(m.nums.bytes)} |`)
    }
  }
  lines.push('', '```', renderActionsVerdict(computeActionsVerdict({ header: undefined as never, measurements: [], actions: a })), '```')
  return lines
}

/** Merges into the RESULTS.json already in `dir` (R4): a run replaces only the blocks it measured. */
export async function writeResults(dir: string, r: Results, measured: { page: boolean; actions: boolean } = { page: true, actions: !!r.actions }): Promise<void> {
  const file = Bun.file(join(dir, 'RESULTS.json'))
  const old = (await file.exists()) ? ((await file.json()) as Results) : undefined
  const merged = mergeResults(old, r, measured)
  await Bun.write(join(dir, 'RESULTS.json'), `${JSON.stringify(merged, null, 2)}\n`)
  await Bun.write(join(dir, 'RESULTS.md'), renderMarkdown(merged))
}
