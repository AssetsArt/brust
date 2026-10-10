// bench/attribution.ts — per-request CPU (process CPU s / requests) and, on an instrumented build, per-stage
// attribution of v2 probes B (/pokemon/{name}?nocache=1) and C (/) under oha. Manual. (m2p ruling 7d164bb6)
//   BRUST_RELEASE_ADDON=1 bun run bench/attribution.ts                        # v2 (+ stages if instrumented)
//   BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x bun run bench/attribution.ts
// Knobs: BENCH_CONN (120, comma list allowed e.g. "120,1"), BENCH_DUR (10s), BENCH_WARMUP (3s), BRUST_WORKERS (6),
// ATTR_PROBES ("B,C"), ATTR_SIDES ("v2,01x"), ATTR_OUT (write JSON there), ATTR_MAXLOAD (cores; cool-down bar).
// Per-stage numbers need the TEMPORARY instrumentation patch (crates/brust-server/src/perf.rs + timers, never
// committed): the server then answers GET /_brust/perf with cumulative {stage: [sum_ns, count]}; this script diffs
// it around the measured run. Without the patch /_brust/perf 404s and only the CPU accounting is reported.
// Host load (1/5/15 min) is recorded before every run; a run started with load > cores is flagged `busy`.
import { readdirSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import snap from '../examples/pokedex/data/pokedex.json'

const ROOT = resolve(import.meta.dir, '..')
const CONNS = (process.env.BENCH_CONN ?? '120').split(',').map((c) => Number.parseInt(c, 10))
const DUR = process.env.BENCH_DUR ?? '10s'
const WARMUP = process.env.BENCH_WARMUP ?? '3s'
const WORKERS = process.env.BRUST_WORKERS ?? '6'
const PROBES = (process.env.ATTR_PROBES ?? 'B,C').split(',')
const SIDES = (process.env.ATTR_SIDES ?? 'v2,01x').split(',')
const NAMES = snap.pokemon.map((p) => p.name)
const CORES = cpus().length
const MAXLOAD = Number(process.env.ATTR_MAXLOAD ?? CORES)
// ATTR_APP=bench: the M3 bench app (bench/apps/brust, probes D = /dex?nocache=1, I = /team?nocache=1) instead of the
// pokedex (probes B, C). The 0.1.x side is pokedex-only and is skipped for the bench app.
const APP = process.env.ATTR_APP === 'bench' ? 'bench' : 'pokedex'
const APP_DIR = APP === 'bench' ? 'bench/apps/brust' : 'examples/pokedex'
/** One URL per probe (D/I: the bench pages; C: the pokedex home); B is a regex over every name. */
const urlOf = (side: string, probe: string): string =>
  probe === 'D' ? '/dex?nocache=1' : probe === 'I' ? '/team?nocache=1' : probe === 'B' ? `/pokemon/pikachu${side === 'v2' ? '?nocache=1' : ''}` : '/'
const target = (side: string, base: string, probe: string) =>
  probe === 'B' ? ['--rand-regex-url', `${base}/pokemon/(${NAMES.join('|')})${side === 'v2' ? '\\?nocache=1' : ''}`] : [`${base}${urlOf(side, probe)}`]

function need(cond: boolean, msg: string): void { if (!cond) { console.error(`[attr] ${msg}`); process.exit(1) } }
need(Bun.spawnSync(['oha', '--version']).exitCode === 0, 'oha not on PATH')
need(process.env.BRUST_RELEASE_ADDON === '1', 'set BRUST_RELEASE_ADDON=1 (built with `bun run build`, not build:debug)')

const CHILDREN: ReturnType<typeof Bun.spawn>[] = []
process.on('exit', () => { for (const c of CHILDREN) c.kill('SIGINT') })
async function waitFor(proc: ReturnType<typeof Bun.spawn>, re: RegExp): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader(); const dec = new TextDecoder(); let out = ''
  for (;;) { const { done, value } = await reader.read(); if (done) throw new Error(`exited:\n${out}`); out += dec.decode(value, { stream: true }); const m = re.exec(out); if (m) { void (async () => { for (;;) { const r = await reader.read(); if (r.done) return } })(); return m[1] ?? '' } }
}
type Srv = { base: string; pid: number; stop: () => void }
async function startV2(): Promise<Srv> {
  const app = join(ROOT, APP_DIR); const bin = join(ROOT, 'packages/brust/bin/brust')
  need(Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app }).exitCode === 0, 'v2 build failed')
  const p = Bun.spawn([bin, 'start', '--port', '38211', '--workers', WORKERS], { cwd: app, env: { ...process.env, BRUST_PORT: '', RUST_LOG: 'warn' }, stdout: 'pipe', stderr: 'inherit' }); CHILDREN.push(p)
  await waitFor(p, /\[brust\] (ready)/)
  return { base: 'http://127.0.0.1:38211', pid: p.pid, stop: () => p.kill('SIGINT') }
}
async function start01x(dir: string): Promise<Srv> {
  need(readdirSync(join(dir, 'runtime')).some((f) => f.endsWith('.node')), `0.1.x addon missing in ${dir}/runtime`)
  const p = Bun.spawn(['bun', 'run', 'example/pokedex/index.ts'], { cwd: dir, env: { ...process.env, BRUST_PORT: '38212', BRUST_WORKERS: WORKERS, RUST_LOG: 'brust=warn' }, stdout: 'pipe', stderr: 'inherit' }); CHILDREN.push(p)
  const port = await waitFor(p, /listening on 127\.0\.0\.1:(\d+)/)
  return { base: `http://127.0.0.1:${port}`, pid: p.pid, stop: () => p.kill('SIGINT') }
}
async function warm(base: string, side: string): Promise<void> {
  if (APP === 'bench') {
    for (const p of ['/dex?nocache=1', '/team?nocache=1', '/types']) for (let i = 0; i < 3; i++) await fetch(`${base}${p}`)
    return
  }
  for (const n of NAMES) await fetch(`${base}/pokemon/${n}${side === 'v2' ? '?nocache=1' : ''}`)
  for (let i = 0; i < 3; i++) await fetch(`${base}/`)
}
/** user+sys CPU seconds of `pid` (macOS/Linux `ps -o time`: [[dd-]hh:]mm:ss.ss). */
function cpuSecs(pid: number): number {
  const t = Bun.spawnSync(['ps', '-o', 'time=', '-p', String(pid)]).stdout.toString().trim()
  const [d, rest] = t.includes('-') ? t.split('-') : ['0', t]
  return rest!.split(':').map(Number).reduce((a, x) => a * 60 + x, 0) + Number(d) * 86400
}
/** Per-thread user+sys CPU seconds (macOS `ps -M`; [] elsewhere). Threads keep their order between two snapshots. */
function threadSecs(pid: number): number[] {
  if (process.platform !== 'darwin') return []
  const sec = (t: string) => t.split(':').map(Number).reduce((a, x) => a * 60 + x, 0)
  return Bun.spawnSync(['ps', '-M', '-p', String(pid)]).stdout.toString().trim().split('\n').slice(1).map((l) => {
    const ts = l.split(/\s+/).filter((x) => /^\d+:\d+\.\d+$/.test(x))
    return ts.length >= 2 ? sec(ts[0]!) + sec(ts[1]!) : 0
  })
}
async function perf(base: string): Promise<Record<string, [number, number]> | null> {
  const r = await fetch(`${base}/_brust/perf`).catch(() => null)
  if (!r || r.status !== 200 || !(r.headers.get('content-type') ?? '').includes('json')) return null
  return (await r.json()) as Record<string, [number, number]>
}
async function oha(conn: number, dur: string, args: string[]): Promise<{ rps: number; total: number; p50: number; p99: number }> {
  const p = Bun.spawn(['oha', '-c', String(conn), '-z', dur, '--no-tui', '--output-format', 'json', '-H', 'accept-encoding: identity', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  need((await p.exited) === 0, `oha failed: ${err}`)
  const j = JSON.parse(out)
  const ok = Object.entries(j.statusCodeDistribution ?? {}).reduce((a, [k, v]) => a + (k.startsWith('2') ? (v as number) : 0), 0)
  return { rps: j.summary.requestsPerSec, total: ok, p50: j.latencyPercentiles.p50 * 1e3, p99: j.latencyPercentiles.p99 * 1e3 }
}

// Stage tree (indent = nesting). Values are mean µs per page request (sum / page requests).
const TREE: [number, string, string][] = [
  [0, 'SVC_TOTAL', 'service fn (handle + header stamping)'],
  [1, 'MATCH', 'route match + accept-encoding'],
  [1, 'L1', 'L1 decision (+ get)'],
  [1, 'CTX_INIT', 'params/path ctx'],
  [1, 'CW_TOTAL', 'loader call_worker (wall)'],
  [2, 'CW_CLAIM', 'claim slot (wait)'],
  [2, 'CW_SER', 'serialize request'],
  [2, 'CW_SPAWN_SCHED', 'tokio::spawn → task runs'],
  [2, 'CW_DISPATCH', 'tsfn call_async → promise resolved'],
  [3, 'BRIDGE', 'tsfn bridge round trip (dispatch − JS handler)'],
  [3, 'CW_JS_TOTAL', 'JS handler (entry → slot written)'],
  [4, 'CW_JS_PARSE', 'JSON.parse'],
  [4, 'CW_JS_HANDLER', 'chain loaders'],
  [4, 'CW_JS_STRINGIFY', 'JSON.stringify'],
  [4, 'CW_JS_WRITE', 'TextEncoder + SAB write'],
  [2, 'CW_READ_PARSE', 'SAB read + serde_json parse'],
  [2, 'CW_JOIN', 'task done → caller resumes'],
  [1, 'MERGE_LOADER', 'merge loader data'],
  [1, 'COLLECT_JOBS', 'collect_jobs'],
  [2, 'CJ_INPUTS', 'job inputs projection'],
  [2, 'CJ_KEY', 'job key (Path::parse / canonical / blake3)'],
  [1, 'JOB_LOOKUP', 'job cache lookups'],
  [1, 'JB_TOTAL', 'jobs call_worker (misses only)'],
  [1, 'SEED', 'seed child slots / useIds'],
  [1, 'MERGE_RESULTS', 'merge job values'],
  [1, 'RENDER_CHAIN', 'render chain'],
  [2, 'CTX_VALUE', 'ctx → minijinja Value'],
  [2, 'OVERLAY', 'overlays (useIds + own maps)'],
  [2, 'SCOPE_BUILD', 'context! merge + get_template'],
  [2, 'TMPL0', 'render leaf template'],
  [2, 'TMPL1', 'render layout template'],
  [2, 'TMPL2', 'render template #3'],
  [1, 'INJECT', 'inject_assets'],
  [1, 'BODY_RESP', 'RenderedBody + response build'],
  [1, 'L1_INSERT', 'L1 store'],
]

const host = () => loadavg().map((l) => Math.round(l * 100) / 100)
const results: unknown[] = []
for (const side of SIDES) {
  const dir = process.env.BRUST_01X_DIR
  if (side === '01x' && !dir) continue
  if (side === '01x' && APP === 'bench') continue
  const srv = side === 'v2' ? await startV2() : await start01x(dir!)
  await warm(srv.base, side)
  for (const probe of PROBES) {
    for (const conn of CONNS) {
      const tgt = target(side, srv.base, probe)
      // Our own previous run inflates the 1-min load average: cool down (≤ 120 s) until it is ≤ ATTR_MAXLOAD (cores).
      for (let i = 0; i < 60 && loadavg()[0]! > MAXLOAD; i++) await Bun.sleep(2000)
      await oha(conn, WARMUP, tgt)
      const load = host()
      const p0 = await perf(srv.base); const c0 = cpuSecs(srv.pid); const t0 = threadSecs(srv.pid); const w0 = performance.now()
      const r = await oha(conn, DUR, tgt)
      const c1 = cpuSecs(srv.pid); const wall = (performance.now() - w0) / 1e3; const t1 = threadSecs(srv.pid); const p1 = await perf(srv.base)
      // Per-thread CPU µs/request, busiest first (threads under 1 % of the run omitted). On v2 the cluster of
      // `available_parallelism` near-equal threads is tokio; the BRUST_WORKERS cluster is the Bun workers.
      const perThread = t1.map((x, i) => x - (t0[i] ?? 0)).filter((x) => x > wall * 0.01).sort((a, b) => b - a).map((x) => Math.round((x / r.total) * 1e7) / 10)
      const loadEnd = host()
      const row: Record<string, unknown> = { side, probe, conn, load, loadEnd, busy: load[0]! > CORES, perThreadUsPerReq: perThread, rps: r.rps, p50: r.p50, p99: r.p99, requests: r.total, cpuSecs: c1 - c0, wall, cpuUsPerReq: ((c1 - c0) / r.total) * 1e6, cores: (c1 - c0) / wall }
      // 0.1.x cache evidence: response headers of one request.
      const h = await fetch(`${srv.base}${urlOf(side, probe)}`, { headers: { 'accept-encoding': 'identity' } })
      row.headers = Object.fromEntries([...h.headers].filter(([k]) => /cache|age|etag|x-brust|content-length|vary/i.test(k)))
      await h.arrayBuffer()
      if (p0 && p1) {
        const d0 = (k: string) => [(p1[k]?.[0] ?? 0) - (p0[k]?.[0] ?? 0), (p1[k]?.[1] ?? 0) - (p0[k]?.[1] ?? 0)] as const
        // The two bridge legs cannot be split: Bun's performance.timeOrigin and Rust's SystemTime disagree by
        // ~0.3-0.7 ms, so only their sum (dispatch wall − JS handler wall, same clocks each) is reported.
        const d = (k: string) => (k === 'BRIDGE' ? ([d0('CW_DISPATCH')[0] - d0('CW_JS_TOTAL')[0], d0('CW_DISPATCH')[1]] as const) : d0(k))
        const n = d('PAGE_TOTAL')[1]
        const svc = d('SVC_TOTAL')[0] / n / 1e3
        row.stages = Object.fromEntries([...Object.keys(p1), 'BRIDGE'].map((k) => [k, { usPerReq: d(k)[0] / n / 1e3, perReq: d(k)[1] / n }]))
        const lines = [`\n### ${side} ${probe} c=${conn} — ${Math.round(r.rps)} rps, ${n} page requests, load ${load.join(' ')}`, '', '| stage | µs/req | % of svc | calls/req |', '|---|---:|---:|---:|']
        for (const [lvl, k, label] of TREE) {
          const [sum, cnt] = d(k); if (cnt === 0) continue
          const us = sum / n / 1e3
          lines.push(`| ${'&nbsp;&nbsp;'.repeat(lvl)}${label} | ${us.toFixed(2)} | ${((us / svc) * 100).toFixed(1)}% | ${(cnt / n).toFixed(2)} |`)
        }
        const kids = TREE.filter(([l]) => l === 1).reduce((a, [, k]) => a + d(k)[0], 0) / n / 1e3
        lines.push(`| &nbsp;&nbsp;unattributed (svc − children) | ${(svc - kids).toFixed(2)} | ${(((svc - kids) / svc) * 100).toFixed(1)}% | |`)
        for (const k of ['CPU_PRE', 'CPU_POST', 'CPU_RENDER']) { const [s, c] = d(k); if (c) lines.push(`| thread CPU ${k} | ${(s / n / 1e3).toFixed(2)} | | |`) }
        for (const k of ['CW_REQ_BYTES', 'CW_RESP_BYTES']) { const [s, c] = d(k); if (c) lines.push(`| ${k} (bytes/call) | ${(s / c).toFixed(0)} | | |`) }
        console.log(lines.join('\n'))
      }
      console.log(`[attr] ${side} ${probe} c=${conn}: ${Math.round(r.rps)} rps, ${r.total} req, CPU ${(c1 - c0).toFixed(2)} s over ${wall.toFixed(1)} s (${(row.cores as number).toFixed(2)} cores) → ${(row.cpuUsPerReq as number).toFixed(1)} µs CPU/req; per-thread µs/req [${perThread.join(' ')}]; load ${load.join(' ')} → ${loadEnd.join(' ')}${row.busy ? ' BUSY' : ''}; headers ${JSON.stringify(row.headers)}`)
      results.push(row)
    }
  }
  srv.stop(); await Bun.sleep(500)
}
if (process.env.ATTR_OUT) writeFileSync(process.env.ATTR_OUT, `${JSON.stringify({ date: new Date().toISOString(), dur: DUR, workers: WORKERS, cores: CORES, results }, null, 2)}\n`)
