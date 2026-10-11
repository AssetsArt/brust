// bench/lib/oha.ts — one oha run → numbers. Pure parse (`parseOha`) + the spawn (`runOha`).
export type Encoding = 'identity' | 'gzip'
export interface OhaOpts { conn: number; dur: string; enc: Encoding }
export interface OhaNums { rps: number; p50: number; p95: number; p99: number; total: number; errors: number; /** status code → count, as oha saw it */ status: Record<string, number>; /** mean response body bytes (oha sizePerRequest) */ bytes: number }
export interface OhaResult extends OhaNums { raw: unknown }

/** Requests oha could not finish before `-z` elapsed: a duration boundary, not a failure. */
const DEADLINE = 'aborted due to deadline'

export function ohaArgs(url: string, o: OhaOpts): string[] {
  return ['-c', String(o.conn), '-z', o.dur, '--no-tui', '--output-format', 'json', '-m', 'GET', '-H', `accept-encoding:${o.enc}`, url]
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

export async function runOha(url: string, o: OhaOpts): Promise<OhaResult> {
  const p = Bun.spawn(['oha', ...ohaArgs(url, o)], { stdout: 'pipe', stderr: 'pipe' })
  RUNNING.add(p)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  RUNNING.delete(p)
  if (code !== 0) throw new Error(`oha exited ${code} for ${url}:\n${err}`)
  return parseOha(JSON.parse(out))
}
