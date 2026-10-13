// website/lib/bench.ts — the landing's benchmark numbers, read from bench/RESULTS.json (never hard-coded, never compared with another framework).
// Only brust's own rows are used: the three pokedex pages (S cached, I interactive, D dynamic), identity encoding.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FILE = join(import.meta.dir, '..', '..', 'bench', 'RESULTS.json')

/** A number with the text it is shown as: the page renders `text`, CountUp animates `end` → `text`. */
export interface Metric {
  end: number
  text: string
  decimals: number
}
export interface Bar {
  /** CSS height, e.g. `43.9%` (min 2%). */
  h: string
  /** CSS animation delay. */
  d: string
  title: string
}
export interface BenchCard {
  probe: 'S' | 'I' | 'D'
  title: string
  pill: string
  path: string
  lead: boolean
  rps: Metric
  p50: Metric
  p99: Metric
  mbps: Metric
  bars: Bar[]
  axisFrom: string
  axisTo: string
}
export interface BenchData {
  date: string
  /** `Tested with oha: …` setup facts, from the header. */
  setup: { conn: number; duration: string; workers: number; machine: string }
  totalRequests: number
  totalText: string
  /** Every request in the three runs answered 200 with no error. */
  allOk: boolean
  hero: Metric
  /** The three pages by probe (fixed keys, so the page can pass `bench.S` etc. as plain props paths). */
  S: BenchCard
  I: BenchCard
  D: BenchCard
}

interface Measurement {
  app: string
  probe: string
  enc: string
  nums: { rps: number; p50: number; p99: number; total: number; errors: number; status: Record<string, number> }
  raw: { summary: { sizePerSec: number }; responseTimeHistogram: Record<string, number> }
}
interface Results {
  header: { date: string; conn: number; dur: string; workers: number; machine: { model: string; chip: string } }
  measurements: Measurement[]
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const one = (n: number) => n.toFixed(1)
const metric = (end: number, decimals: number): Metric => ({ end, text: decimals === 0 ? int(end) : end.toFixed(decimals), decimals })
/** < 1 ms keeps two decimals, above it one. */
const ms = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} ms`

const CARDS: { probe: 'S' | 'I' | 'D'; title: string; pill: string; path: string }[] = [
  { probe: 'S', title: 'Cached page', pill: 'L1 hit', path: 'GET /types' },
  { probe: 'I', title: 'Interactive page', pill: 'one React island', path: 'GET /team' },
  { probe: 'D', title: 'Dynamic page', pill: 'loader every request', path: 'GET /dex' },
]

export function parseBench(results: Results): BenchData {
  const row = (probe: string): Measurement => {
    const m = results.measurements.find((x) => x.app === 'brust' && x.probe === probe && x.enc === 'identity')
    if (!m) throw new Error(`bench/RESULTS.json has no brust ${probe} identity row`)
    return m
  }
  const rows = CARDS.map((c) => row(c.probe))
  const totalRequests = rows.reduce((n, m) => n + m.nums.total, 0)
  const allOk = rows.every((m) => m.nums.errors === 0 && Object.keys(m.nums.status).every((s) => s === '200'))
  const h = results.header
  const cards: BenchCard[] = CARDS.map((c, i) => {
    const m = rows[i]!
    const buckets = Object.entries(m.raw.responseTimeHistogram)
      .map(([k, n]) => [Number(k), n] as const)
      .sort((a, b) => a[0] - b[0])
    const max = Math.max(...buckets.map(([, n]) => n))
    return {
      ...c,
      lead: c.probe === 'S',
      rps: metric(m.nums.rps, 0),
      p50: metric(Number(one(m.nums.p50)), 1),
      p99: metric(Number(one(m.nums.p99)), 1),
      mbps: metric(Math.round(m.raw.summary.sizePerSec / 1e6), 0),
      bars: buckets.map(([k, n], j) => ({
        h: `${Math.max(2, (n / max) * 100).toFixed(1)}%`,
        d: `${(j * 0.04).toFixed(2)}s`,
        title: `${n.toLocaleString('en-US')} requests up to ${(k * 1000).toFixed(2)} ms`,
      })),
      axisFrom: ms(buckets[0]![0] * 1000),
      axisTo: ms(buckets[buckets.length - 1]![0] * 1000),
    }
  })
  const secs = /^(\d+)s$/.exec(h.dur)
  return {
    date: h.date,
    setup: { conn: h.conn, duration: secs ? `${secs[1]} seconds` : h.dur, workers: h.workers, machine: `${h.machine.model} ${h.machine.chip.replace(/^Apple /, '')}` },
    totalRequests,
    totalText: int(totalRequests),
    allOk,
    hero: cards[0]!.rps,
    S: cards[0]!,
    I: cards[1]!,
    D: cards[2]!,
  }
}

let cache: { mtime: number; data: BenchData } | undefined

/** Reads bench/RESULTS.json (re-read when the file changes, so a bench re-run moves the numbers). */
export function loadBench(): BenchData {
  const mtime = statSync(FILE).mtimeMs
  if (!cache || cache.mtime !== mtime) cache = { mtime, data: parseBench(JSON.parse(readFileSync(FILE, 'utf8')) as Results) }
  return cache.data
}
