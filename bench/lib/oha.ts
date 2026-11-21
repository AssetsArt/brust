// bench/lib/oha.ts — one oha run → numbers. Pure parse (`parseOha`) + the spawn (`runOha`).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cpuOf } from './cpu'
export type Encoding = 'identity' | 'gzip'
export interface OhaOpts { conn: number; dur: string; enc: Encoding; method?: 'GET' | 'POST'; body?: string }
export interface OhaNums { rps: number; p50: number; p95: number; p99: number; total: number; errors: number; /** status code → count, as oha saw it */ status: Record<string, number>; /** mean response body bytes (oha sizePerRequest) */ bytes: number }
export interface OhaResult extends OhaNums { raw: unknown }

/** Requests oha could not finish before `-z` elapsed: a duration boundary, not a failure. */
const DEADLINE = 'aborted due to deadline'

export function ohaArgs(url: string, o: OhaOpts): string[] {
  const args = ['-c', String(o.conn), '-z', o.dur, '--no-tui', '--output-format', 'json', '-m', o.method ?? 'GET', '-H', `accept-encoding:${o.enc}`]
  if (o.body !== undefined) args.push('-d', o.body, '-H', 'content-type:application/json')
  return [...args, url]
}

const sum = (rec: unknown, skip?: string): number =>
  typeof rec === 'object' && rec !== null
    ? Object.entries(rec as Record<string, unknown>).reduce((a, [k, v]) => (k === skip || typeof v !== 'number' ? a : a + v), 0)
    : 0

const statusOf = (rec: unknown): Record<string, number> =>
  typeof rec === 'object' && rec !== null ? Object.fromEntries(Object.entries(rec as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number')) : {}

/** A measurement is only a throughput if every request succeeded: any transport error or non-200 status fails it. */
export function validateRun(n: OhaNums, label: string): void {
  const bad = Object.entries(n.status).filter(([code]) => code !== '200')
  if (n.errors > 0 || bad.length > 0 || n.total === 0)
    throw new Error(`${label}: not a valid measurement — ${n.errors} transport errors, statuses ${JSON.stringify(n.status)}, ${n.total} responses`)
}

export function parseOha(json: unknown): OhaResult {
  if (typeof json !== 'object' || json === null) throw new Error(`oha json: expected an object, got ${JSON.stringify(json)}`)
  const j = json as { summary?: { requestsPerSec?: number; sizePerRequest?: number }; latencyPercentiles?: Record<string, number>; statusCodeDistribution?: unknown; errorDistribution?: unknown }
  const rps = j.summary?.requestsPerSec
  if (typeof rps !== 'number') throw new Error('oha json: summary.requestsPerSec missing')
  const ms = (k: string): number => {
    const v = j.latencyPercentiles?.[k]
    if (typeof v !== 'number') throw new Error(`oha json: latencyPercentiles.${k} missing`)
    return v * 1000
  }
  return { rps, p50: ms('p50'), p95: ms('p95'), p99: ms('p99'), total: sum(j.statusCodeDistribution), errors: sum(j.errorDistribution, DEADLINE), status: statusOf(j.statusCodeDistribution), bytes: j.summary?.sizePerRequest ?? 0, raw: json }
}

const RUNNING = new Set<{ kill(sig?: number | NodeJS.Signals): void }>()
process.on('exit', () => { for (const p of RUNNING) p.kill('SIGKILL') }) // an interrupted run never leaves oha hammering a port

/** F595 D1: `oha` on PATH, else cargo's install dir; null when neither has it. */
export function ohaPath(): string | null {
  const onPath = Bun.which('oha')
  if (onPath) return onPath
  const home = process.env.HOME
  return home && existsSync(join(home, '.cargo/bin/oha')) ? join(home, '.cargo/bin/oha') : null
}

export interface OhaRun extends OhaResult {
  /** F595 D6: CPU seconds the oha process used (Linux /proc; null elsewhere) and the wall time of the run. */
  genCpu: number | null
  wall: number
}

/** One oha run. `prefix` pins it (`taskset -c <L>`, which execs oha in the same pid, so its CPU is read from that pid). */
export async function runOha(url: string, o: OhaOpts, run: { prefix?: string[] } = {}): Promise<OhaRun> {
  const bin = ohaPath()
  if (!bin) throw new Error('oha not found on PATH or in ~/.cargo/bin (cargo install oha)')
  const t0 = performance.now()
  const p = Bun.spawn([...(run.prefix ?? []), bin, ...ohaArgs(url, o)], { stdout: 'pipe', stderr: 'pipe' })
  RUNNING.add(p)
  let genCpu: number | null = cpuOf(p.pid)
  const poll = setInterval(() => {
    const c = cpuOf(p.pid)
    if (c !== null) genCpu = c
  }, 200)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearInterval(poll)
  const wall = (performance.now() - t0) / 1000
  RUNNING.delete(p)
  if (code !== 0) throw new Error(`oha exited ${code} for ${url}:\n${err}`)
  return { ...parseOha(JSON.parse(out)), genCpu, wall }
}
