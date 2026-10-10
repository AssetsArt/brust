// bench/lib/oha.ts — one oha run → numbers. Pure parse (`parseOha`) + the spawn (`runOha`).
export type Encoding = 'identity' | 'gzip'
export interface OhaOpts { conn: number; dur: string; enc: Encoding }
export interface OhaNums { rps: number; p50: number; p95: number; p99: number; total: number; errors: number }
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

export function parseOha(json: unknown): OhaResult {
  if (typeof json !== 'object' || json === null) throw new Error(`oha json: expected an object, got ${JSON.stringify(json)}`)
  const j = json as { summary?: { requestsPerSec?: number }; latencyPercentiles?: Record<string, number>; statusCodeDistribution?: unknown; errorDistribution?: unknown }
  const rps = j.summary?.requestsPerSec
  if (typeof rps !== 'number') throw new Error('oha json: summary.requestsPerSec missing')
  const ms = (k: string): number => {
    const v = j.latencyPercentiles?.[k]
    if (typeof v !== 'number') throw new Error(`oha json: latencyPercentiles.${k} missing`)
    return v * 1000
  }
  return { rps, p50: ms('p50'), p95: ms('p95'), p99: ms('p99'), total: sum(j.statusCodeDistribution), errors: sum(j.errorDistribution, DEADLINE), raw: json }
}

export async function runOha(url: string, o: OhaOpts): Promise<OhaResult> {
  const p = Bun.spawn(['oha', ...ohaArgs(url, o)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`oha exited ${code} for ${url}:\n${err}`)
  return parseOha(JSON.parse(out))
}
