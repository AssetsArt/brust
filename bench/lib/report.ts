// bench/lib/report.ts — RESULTS.json (raw) + RESULTS.md (header, one table per probe, computed verdict block).
// No prose is generated here: the method lives in bench/README.md (spec §1.5).
import { join } from 'node:path'
import type { AppId } from './app'
import type { Encoding, OhaNums } from './oha'
import { PROBES, type ProbeId } from './probes'

export interface Measurement { app: AppId; probe: ProbeId; enc: Encoding; nums: OhaNums; raw: unknown }
export interface Header {
  date: string; host: string; cores: number; loadavg: number[]; seed: number; conn: number; dur: string; warmup: string; settleMs: number; workers: number
  versions: Record<string, string>; apps: AppId[]; skipped: { app: AppId; reason: string }[]; order: string[]
  /** process budget per app, e.g. 'brust workers=10', 'next procs=1 (as shipped)' */
  budgets: Record<string, string>
  /** bun-serve reusePort balance verdict: true = every copy served >= 5%, false = 1-proc, null = not run */
  bunServeBalanced: boolean | null
}
export interface Results { header: Header; measurements: Measurement[] }
export interface Verdict {
  f68: { d: number | null; i: number | null; met: boolean | null }
  sanity: { s: number | null; d: number | null; i: number | null; met: boolean | null }
  ceiling: { d: number | null; i: number | null; basis: 'equal-budget' | '1-proc' }
}

export const APP_LABEL: Record<AppId, string> = { brust: 'brust', 'bun-serve': 'bun-serve', next: 'next', 'brust-01x': 'brust-01x' }

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

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const ms = (n: number) => n.toFixed(2)

export function renderMarkdown(r: Results): string {
  const h = r.header
  const versions = Object.entries(h.versions).map(([k, v]) => `${k} ${v}`).join(' · ')
  const lines: string[] = [
    `# bench — ${h.date}`,
    '',
    `host ${h.host} · ${versions} · seed ${h.seed} · \`oha -c ${h.conn} -z ${h.dur}\` · settle ${h.settleMs} ms + warm-up ${h.warmup} discarded · budgets ${Object.entries(h.budgets).map(([k, v]) => `${k} ${v}`).join(', ')} · load ${h.loadavg.map((n) => n.toFixed(1)).join(' ')} (${h.cores} cores) · order ${h.order.join(' ')}`,
  ]
  if (h.skipped.length) lines.push('', `skipped: ${h.skipped.map((s) => `${s.app} (${s.reason})`).join(', ')}`)
  for (const p of PROBES) {
    lines.push('', `## ${p.id} — \`${p.path}\``, '', '| app | rps | p50 ms | p95 ms | p99 ms | errors | bytes/resp | gzip rps | gzip p50 | gzip p99 | gzip bytes/resp |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const app of h.apps) {
      const id = r.measurements.find((m) => m.app === app && m.probe === p.id && m.enc === 'identity')
      if (!id) continue
      const gz = r.measurements.find((m) => m.app === app && m.probe === p.id && m.enc === 'gzip')
      lines.push(`| ${APP_LABEL[app]} | ${int(id.nums.rps)} | ${ms(id.nums.p50)} | ${ms(id.nums.p95)} | ${ms(id.nums.p99)} | ${id.nums.errors} | ${int(id.nums.bytes)} | ${gz ? int(gz.nums.rps) : '—'} | ${gz ? ms(gz.nums.p50) : '—'} | ${gz ? ms(gz.nums.p99) : '—'} | ${gz ? int(gz.nums.bytes) : '—'} |`)
    }
  }
  lines.push('', '```', renderVerdict(computeVerdict(r)), '```', '', 'Generated by `bun run bench` (`bench/run.ts`) from `RESULTS.json`; method and reading guide in `bench/README.md`.', '')
  return lines.join('\n')
}

export async function writeResults(dir: string, r: Results): Promise<void> {
  await Bun.write(join(dir, 'RESULTS.json'), `${JSON.stringify(r, null, 2)}\n`)
  await Bun.write(join(dir, 'RESULTS.md'), renderMarkdown(r))
}
