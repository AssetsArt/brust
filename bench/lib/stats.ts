// bench/lib/stats.ts — F595 D5-D7: repeated cells, their median and spread, the marks, the interleaved order and the
// sweep's best worker count. Pure.
import { mulberry32, shuffle } from './random'

export const NOISY_SPREAD = 0.05
export const GENERATOR_LIMIT = 0.9
export const UNBALANCED_RATIO = 2
export const SWEEP_P99_SLACK = 0.2

export interface Spread { median: number; min: number; max: number; /** (max - min) / median */ spread: number }
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median of no values')
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}
export function spreadOf(xs: number[]): Spread {
  const m = median(xs)
  const min = Math.min(...xs)
  const max = Math.max(...xs)
  return { median: m, min, max, spread: m === 0 ? 0 : (max - min) / m }
}
export const noisy = (s: Spread): boolean => s.spread > NOISY_SPREAD
/** The generator used `cpuSeconds` of CPU during a load window of `durSeconds` (oha's `-z`, not the process's wall time,
 * which adds spawn and JSON output) on `genCpus` logical CPUs. */
export const generatorShare = (cpuSeconds: number, durSeconds: number, genCpus: number): number =>
  durSeconds <= 0 || genCpus <= 0 ? 0 : cpuSeconds / (durSeconds * genCpus)
export const generatorLimited = (share: number): boolean => share >= GENERATOR_LIMIT

/** Per-process work of one multi-process app (CPU seconds or request counts): busiest / idlest. */
export function balanceRatio(perProcess: number[]): number {
  if (perProcess.length < 2) return 1
  const min = Math.min(...perProcess)
  const max = Math.max(...perProcess)
  return min <= 0 ? Number.POSITIVE_INFINITY : max / min
}
export const unbalanced = (ratio: number): boolean => ratio > UNBALANCED_RATIO

/** D5: `rounds` rounds over the same cells, each round in its own shuffled order from one seeded generator. */
export function interleave<T>(cells: readonly T[], rounds: number, seed: number): { round: number; cell: T }[] {
  const rnd = mulberry32(seed)
  const out: { round: number; cell: T }[] = []
  for (let r = 0; r < rounds; r++) for (const cell of shuffle(cells, rnd)) out.push({ round: r, cell })
  return out
}

export interface SweepPoint { n: number; rps: number; p99: number }
/** D7: the highest median rps whose p99 is within 20% of the best (lowest) p99 among the points. */
export function bestN(points: SweepPoint[]): SweepPoint | null {
  if (points.length === 0) return null
  const bestP99 = Math.min(...points.map((p) => p.p99))
  const ok = points.filter((p) => p.p99 <= bestP99 * (1 + SWEEP_P99_SLACK))
  return ok.reduce((a, b) => (b.rps > a.rps || (b.rps === a.rps && b.n < a.n) ? b : a))
}

/** D7: 1, 2, 3, then every count up to `max`, capped at 8 points (the largest counts kept when it must thin). */
export function defaultSweep(max: number): number[] {
  const all = Array.from({ length: Math.max(1, max) }, (_, i) => i + 1)
  if (all.length <= 8) return all
  const head = [1, 2, 3]
  const rest = all.slice(3)
  const step = (rest.length - 1) / 4
  const picked = Array.from({ length: 5 }, (_, i) => rest[Math.round(i * step)] as number)
  return [...new Set([...head, ...picked])]
}
