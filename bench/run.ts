// bench/run.ts — the bench suite (spec §1; F595: fair to every side and repeatable). Manual, load-guarded, never in CI.
//   BRUST_RELEASE_ADDON=1 bun run bench                         # one full run: brust, bun-serve, next, elysia-bun
//   BRUST_RELEASE_ADDON=1 bun run bench --sweep default         # the worker sweep (brust, bun-serve, elysia-bun)
//   bun bench/run.ts --apps brust,next --probes D --rounds 3 --dur 5s --seed 7
// Flow: topology (server CPUs S / generator CPUs L, never shared) → guards → build → parity + the work each app does →
// every app started once inside S with the same process count N → cells (app, probe, encoding, connections) measured
// R times, interleaved in a seeded order per round, the host checked idle before each → medians, spreads and marks →
// bench/results/<date>-<chip>-<os>.{json,md} (bench/RESULTS.* only with --publish). Exit 0 ok, 1 failure, 2 busy host.
import { mkdirSync, readFileSync } from 'node:fs'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import data from './apps/_shared/data.json'
import { type AppId, type AppSpec, killAllOnExit, type RunningApp, startApp } from './lib/app'
import { APP_ORDER, APPS, ROOT } from './lib/apps'
import { cpuDelta, groupCpu, hostBusy } from './lib/cpu'
import { aggregate, type Cell, type CellKey, type CellRun, type FairResults, legacyResults, renderRun, type Work } from './lib/fair'
import { evaluateGuards, probeHost } from './lib/guard'
import { acquireHostLock } from './lib/lock'
import { type Encoding, runOha, validateRun } from './lib/oha'
import { checkJsonParity, checkParity, type JsonResponse } from './lib/parity'
import { probe as probeOf, type ProbeId, serves } from './lib/probes'
import { type Machine, writeResults } from './lib/report'
import { defaultSweep, generatorShare, interleave } from './lib/stats'
import { cpuList, readTopology, splitCores } from './lib/topology'

const { values: f } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apps: { type: 'string' }, probes: { type: 'string', default: 'S,S-render,D,I,A1,A2' },
    conn: { type: 'string', default: '120,auto' }, dur: { type: 'string' }, warmup: { type: 'string', default: '2s' },
    rounds: { type: 'string' }, enc: { type: 'string' }, seed: { type: 'string' }, workers: { type: 'string' },
    'gen-cores': { type: 'string', default: '2' }, sweep: { type: 'string' }, publish: { type: 'boolean', default: false },
    out: { type: 'string', default: 'bench/results' }, timeout: { type: 'string', default: '90000' },
    'idle-max': { type: 'string', default: '1' }, 'idle-wait': { type: 'string', default: '180' },
  },
})
const say = (s: string) => console.log(`[bench] ${s}`)
const die = (code: 1 | 2, s: string): never => {
  console.error(`[bench] ${s}`)
  process.exit(code)
}
const int = (s: string | undefined, name: string, min = 0): number => {
  const n = Number.parseInt(s ?? '', 10)
  if (!Number.isInteger(n) || n < min) die(1, `--${name} must be an integer >= ${min} (got ${s})`)
  return n
}

const sweeping = f.sweep !== undefined
const SWEEP_APPS: AppId[] = ['brust', 'bun-serve', 'elysia-bun']
const appIds = (f.apps ?? (sweeping ? SWEEP_APPS : APP_ORDER.filter((a) => a !== 'brust-01x')).join(',')).split(',').map((s) => s.trim()).filter(Boolean) as AppId[]
for (const a of appIds) if (!(a in APPS)) die(1, `unknown app ${a} (choose from ${APP_ORDER.join(', ')})`)
const probeIds = f.probes!.split(',').map((s) => s.trim()).filter(Boolean) as ProbeId[]
for (const p of probeIds) probeOf(p)
const encArg = f.enc ?? (sweeping ? 'identity' : 'both')
const encs: Encoding[] = encArg === 'both' ? ['identity', 'gzip'] : encArg === 'identity' || encArg === 'gzip' ? [encArg] : die(1, '--enc must be identity|gzip|both')
const rounds = int(f.rounds ?? (sweeping ? '3' : '5'), 'rounds', 1)
const dur = f.dur ?? (sweeping ? '6s' : '10s')
const seed = f.seed !== undefined ? int(f.seed, 'seed') : Date.now() % 1_000_000_000
const timeoutMs = int(f.timeout, 'timeout', 1000)
const idleMax = Number.parseFloat(f['idle-max']!)
const idleWaitS = int(f['idle-wait'], 'idle-wait', 0)
const secs = (d: string) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(d)
  if (!m) die(1, `durations are like 10s, 500ms, 1m (got ${d})`)
  const n = Number.parseFloat(m![1]!)
  return m![2] === 'ms' ? n / 1000 : m![2] === 'm' ? n * 60 : n
}

// 1. Topology (D2): the servers and the generator never share a physical core.
const topo = readTopology()
let serverCpus: number[] | null = null
let genCpus: number[] | null = null
if (topo) {
  try {
    const s = splitCores(topo, int(f['gen-cores'], 'gen-cores', 1))
    serverCpus = s.server
    genCpus = s.gen
  } catch (e) {
    die(1, (e as Error).message)
  }
}
const serverPrefix = serverCpus ? ['taskset', '-c', cpuList(serverCpus)] : []
const genPrefix = genCpus ? ['taskset', '-c', cpuList(genCpus)] : []
const logical = cpus().length
const serverLogical = serverCpus?.length ?? logical
say(serverCpus ? `server CPUs ${cpuList(serverCpus)} · generator CPUs ${cpuList(genCpus!)}` : 'cannot pin on this host (no taskset / lscpu): unpinned, ratios only')

// 2. Guards (busy host → 2; a missing tool the run needs → 1).
const skipped: { app: AppId; reason: string }[] = []
const apps: AppSpec[] = []
for (const id of appIds) {
  const av = APPS[id].available()
  if (av.ok) apps.push(APPS[id])
  else {
    skipped.push({ app: id, reason: av.reason })
    say(`${id}: skipped (${av.reason})`)
  }
}
if (apps.length === 0) die(1, 'no app to measure')
const nodeNeeded = apps.some((a) => a.id === 'next') && (await import('./lib/apps')).nextRuntime().name === 'node'
const guardInput = () => probeHost({ needNode: nodeNeeded, needBrustAddon: apps.some((a) => a.id === 'brust') })
const g = evaluateGuards(guardInput())
if (!g.ok) die(g.code, g.reason)
killAllOnExit()

// The counts: D3 one N for every app (default: the server set's logical CPUs); D7 the sweep's list.
const defaultN = serverLogical
const ns: number[] = sweeping
  ? f.sweep === 'default' || f.sweep === ''
    ? defaultSweep(serverLogical)
    : f.sweep!.split(',').map((s) => int(s.trim(), 'sweep', 1))
  : [f.workers !== undefined ? int(f.workers, 'workers', 1) : defaultN]

// 3. Build every app (production mode).
for (const a of apps) {
  say(`build ${a.id} …`)
  try {
    await a.build((s) => {
      if (s) console.log(s.split('\n').map((l) => `  ${l}`).join('\n'))
    })
  } catch (e) {
    die(1, `build ${a.id} failed: ${(e as Error).message}`)
  }
}

const request = (base: string, p: ProbeId, enc: Encoding = 'identity') => {
  const pr = probeOf(p)
  const headers: Record<string, string> = { 'accept-encoding': enc }
  if (pr.method === 'POST') headers['content-type'] = 'application/json'
  return fetch(`${base}${pr.path}`, { method: pr.method, headers, ...(pr.body !== undefined ? { body: pr.body } : {}), decompress: false } as RequestInit)
}
const setN = (n: number) => {
  process.env.BENCH_WORKERS = String(n)
}
const start = (a: AppSpec) => startApp(a, { timeoutMs, prefix: serverPrefix }).catch((e) => die(1, (e as Error).message))

// 4. Parity before any load, and the work each app does for each probe (AMENDMENT 1, D4): measured, never assumed.
setN(ns[0]!)
const pageProbes = probeIds.filter((p) => probeOf(p).kind === 'page')
const jsonProbes = probeIds.filter((p) => probeOf(p).kind === 'json')
const html: Partial<Record<ProbeId, { app: string; html: string }[]>> = {}
const json: Partial<Record<ProbeId, JsonResponse[]>> = {}
const EXPECTED: Partial<Record<ProbeId, unknown>> = { A1: data.types, A2: { ok: true, id: 25 } }
const work: Work[] = []
const compressedOf = new Map<string, boolean | null>()
for (const a of apps) {
  const mine = probeIds.filter((p) => serves(a.id, p))
  if (mine.length === 0) continue
  const run = await start(a)
  try {
    await Bun.sleep(1000)
    for (const p of mine) {
      if (a.sanity) await a.sanity(run.base, p).catch((e) => die(1, (e as Error).message))
      // twice: the second answer is the one a cache serves
      await (await request(run.base, p)).arrayBuffer()
      const r = await request(run.base, p)
      const body = new Uint8Array(await r.arrayBuffer())
      const text = new TextDecoder().decode(body)
      const gz = await request(run.base, p, 'gzip')
      const enc = gz.headers.get('content-encoding')
      await gz.arrayBuffer()
      const compressed = probeOf(p).kind === 'page' ? enc !== null && enc !== 'identity' : null
      compressedOf.set(`${a.id}|${p}`, compressed)
      const cache = r.headers.get('x-brust-cache') ?? r.headers.get('x-nextjs-cache')
      const parts: string[] = []
      if (probeOf(p).kind === 'page') {
        parts.push(cache === 'HIT' ? `cached (${r.headers.has('x-brust-cache') ? 'x-brust-cache' : 'x-nextjs-cache'} HIT)` : 'renders per request')
        parts.push(/<script\b[^>]*\bsrc=/.test(text) || /<brust-island\b/.test(text) ? 'hydration scripts' : 'no hydration (no scripts)')
        parts.push(compressed ? `compressed (${enc})` : 'not compressed')
      } else parts.push('json')
      work.push({ app: a.id, probe: p, work: parts.join(', '), compressed, bytes: body.byteLength })
      if (probeOf(p).kind === 'page') {
        if (r.status !== 200) die(1, `${a.id} ${probeOf(p).path} → HTTP ${r.status}`)
        ;(html[p] ??= []).push({ app: a.id, html: text })
      } else (json[p] ??= []).push({ app: a.id, status: r.status, contentType: r.headers.get('content-type'), body: text })
    }
  } finally {
    await run.stop()
  }
}
for (const p of pageProbes) {
  const pages = html[p] ?? []
  if (pages.length > 1) await checkParity(pages, p).catch((e) => die(1, (e as Error).message))
  say(`parity ${p}: ${pages.map((x) => x.app).join(' = ')} ✓`)
}
for (const p of jsonProbes) {
  const rs = json[p] ?? []
  await checkJsonParity(rs, p, EXPECTED[p]).catch((e) => die(1, (e as Error).message))
  say(`parity ${p}: ${rs.map((x) => x.app).join(' = ')} ✓`)
}
for (const w of work) say(`work ${w.app} ${w.probe}: ${w.work}, ${w.bytes} B`)

// Versions before the load: a failure here never costs a finished run.
const versions: Record<string, string> = { bun: Bun.version }
const ohaV = Bun.spawnSync([(await import('./lib/oha')).ohaPath() ?? 'oha', '--version'], { stdout: 'pipe', stderr: 'pipe' })
versions.oha = ohaV.exitCode === 0 ? ohaV.stdout.toString().trim().replace(/^oha /, '') : '?'
for (const a of apps) versions[a.id] = await a.version().catch((e: Error) => `? (${e.message})`)
const sha = (() => {
  const r = Bun.spawnSync(['git', 'rev-parse', '--short=10', 'HEAD'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 ? r.stdout.toString().trim() : (process.env.BENCH_SHA ?? 'unknown')
})()
/** What the runtimes would pick inside the server set (D7): `nproc` under the same pinning. */
const insideS = (() => {
  const r = Bun.spawnSync([...serverPrefix, 'nproc'], { stdout: 'pipe', stderr: 'pipe' })
  const n = r.exitCode === 0 ? Number.parseInt(r.stdout.toString(), 10) : availableParallelism()
  return Number.isInteger(n) ? n : null
})()

// 5. The cells.
const allConns = f.conn!.split(',').map((s) => s.trim())
const fixedConns = allConns.filter((c) => c !== 'auto').map((c) => int(c, 'conn', 1))
const topConn = Math.max(...fixedConns)
const cellsFor = (n: number, conns: number[]): CellKey[] =>
  apps.flatMap((a) =>
    probeIds
      .filter((p) => serves(a.id, p))
      .flatMap((p) =>
        probeOf(p).kind === 'page'
          ? encs.flatMap((enc) => conns.map((conn) => ({ app: a.id, probe: p, enc, conn, n })))
          : [...new Set([...conns, ...(sweeping ? [] : [1])])].map((conn) => ({ app: a.id, probe: p, enc: 'identity' as Encoding, conn, n })),
      ),
  )

/** D5: before each cell the host outside the bench must be idle: at most `--idle-max` CPUs busy (servers are idle
 * between cells, so what is busy is someone else). Waits, then aborts with 2. */
async function waitIdle(label: string): Promise<void> {
  const deadline = Date.now() + idleWaitS * 1000
  for (;;) {
    const busy = await hostBusy(1000)
    if (busy === null) {
      const g = evaluateGuards(guardInput())
      if (g.ok) return
      if (Date.now() > deadline) die(2, `${label}: ${(g as { reason: string }).reason}`)
    } else {
      const cpusBusy = busy * logical
      if (cpusBusy <= idleMax) return
      if (Date.now() > deadline) die(2, `${label}: ${cpusBusy.toFixed(1)} CPUs busy outside the bench for ${idleWaitS} s (allowed ${idleMax}) — refusing to measure`)
      say(`${label}: ${cpusBusy.toFixed(1)} CPUs busy outside the bench, waiting`)
    }
    await Bun.sleep(4000)
  }
}

/** D6: the second connection count: the largest at which the generator stays under 80% of its CPUs on the fastest
 * probe of this run, so its row measures the servers. */
async function calibrate(running: Map<AppId, RunningApp>): Promise<number> {
  const order: [AppId, ProbeId][] = [['brust', 'S'], ['bun-serve', 'S-render'], ['brust', 'A1'], ['elysia-bun', 'A1'], ['brust', 'D']]
  const pick = order.find(([a, p]) => running.has(a) && probeIds.includes(p))
  if (!pick || !genCpus) return 32
  const [a, p] = pick
  const url = `${running.get(a)!.base}${probeOf(p).path}`
  for (const c of [64, 48, 32, 24, 16, 8, 4]) {
    const r = await runOha(url, { conn: c, dur: '3s', enc: 'identity', method: probeOf(p).method, ...(probeOf(p).body !== undefined ? { body: probeOf(p).body } : {}) }, { prefix: genPrefix })
    const share = r.genCpu === null ? 0 : generatorShare(r.genCpu, r.wall, genCpus.length)
    say(`calibrate ${a} ${p} c=${c}: generator ${(share * 100).toFixed(0)}% of its CPUs`)
    if (share < 0.8) return c
  }
  return 4
}

const t0 = Date.now()
const runs = new Map<string, { key: CellKey; runs: CellRun[] }>()
const keyOf = (k: CellKey) => `${k.app}|${k.probe}|${k.enc}|${k.conn}|${k.n}`
const perCell = secs(f.warmup!) + secs(dur) + 2
const plannedConns = allConns.includes('auto') ? [...fixedConns, 0] : fixedConns
const estimateMin = Math.ceil(ns.reduce((t, n) => t + cellsFor(n, sweeping ? [topConn] : plannedConns).length * rounds * perCell, 0) / 60)
say(`about ${estimateMin} min of load (${ns.length > 1 ? `N = ${ns.join(', ')}; ` : `N = ${ns[0]}; `}${rounds} rounds; ${f.warmup} warm-up + ${dur} per measurement)`)
const releaseLock = await acquireHostLock(say)
let usedConns: number[] = fixedConns
try {
  for (const n of ns) {
    setN(n)
    const running = new Map<AppId, RunningApp>()
    for (const a of apps) running.set(a.id, await start(a))
    await Bun.sleep(1500)
    if (allConns.includes('auto') && usedConns === fixedConns) {
      const low = await calibrate(running)
      usedConns = [...new Set([...fixedConns, low])].sort((a, b) => b - a)
      say(`connections: ${usedConns.join(', ')} (the lower one keeps the generator under 80% on the fastest probe)`)
    }
    const conns = sweeping ? [topConn] : usedConns
    const cells = cellsFor(n, conns)
    const plan = interleave(cells, rounds, seed + n)
    const minutes = Math.ceil((plan.length * perCell) / 60)
    say(`${sweeping ? `N=${n}: ` : ''}${cells.length} cells × ${rounds} rounds = ${plan.length} measurements, about ${minutes} min`)
    for (const [i, { round, cell }] of plan.entries()) {
      const a = running.get(cell.app)!
      const pr = probeOf(cell.probe)
      const url = `${a.base}${pr.path}`
      const label = `${cell.app} ${cell.probe} ${cell.enc} c=${cell.conn}${sweeping ? ` N=${n}` : ''} r${round + 1}`
      await waitIdle(label)
      const o = { conn: cell.conn, enc: cell.enc, method: pr.method, ...(pr.body !== undefined ? { body: pr.body } : {}) }
      await runOha(url, { ...o, dur: f.warmup! }, { prefix: genPrefix })
      const spec = APPS[cell.app]
      const before = spec.multiProcess ? groupCpu(a.proc.pid) : null
      const r = await runOha(url, { ...o, dur }, { prefix: genPrefix })
      const after = spec.multiProcess ? groupCpu(a.proc.pid) : null
      const { raw: _raw, genCpu, wall, ...nums } = r
      try {
        validateRun(nums, label)
      } catch (e) {
        die(1, (e as Error).message)
      }
      // The copies of a multi-process app, not its launcher (the group leader).
      const procCpu = before && after ? [...cpuDelta(before, after)].filter(([pid]) => pid !== a.proc.pid).map(([, c]) => c) : []
      const gen = genCpu === null || !genCpus ? null : generatorShare(genCpu, wall, genCpus.length)
      const k = keyOf(cell)
      const slot = runs.get(k) ?? { key: cell, runs: [] }
      slot.runs.push({ round, nums, gen, procCpu })
      runs.set(k, slot)
      console.log(`  [${i + 1}/${plan.length}] ${label.padEnd(36)} ${nums.rps.toFixed(0).padStart(8)} rps  p99 ${nums.p99.toFixed(2)} ms  gen ${gen === null ? '—' : `${Math.round(gen * 100)}%`}${procCpu.length > 1 ? `  procs ${procCpu.map((c) => c.toFixed(1)).join('/')} s` : ''}`)
    }
    for (const a of running.values()) await a.stop()
  }
} finally {
  releaseLock()
}

// 6. Report.
const cells: Cell[] = [...runs.values()].map(({ key, runs: rs }) => aggregate(key, rs, compressedOf.get(`${key.app}|${key.probe}`) ?? null))
const machine = describeMachine()
const budgets: Record<string, string> = Object.fromEntries(
  apps.map((a) => [a.id, `${a.id === 'brust' ? 'workers' : 'processes'} ${sweeping ? ns.join(',') : ns[0]}${a.id === 'brust' ? ' (one process)' : ''}`]),
)
const date = new Date().toISOString().slice(0, 10)
const results: FairResults = {
  header: {
    kind: sweeping ? 'sweep' : 'run', date, machine, os: `${process.platform}/${process.arch}`, cores: logical, serverCpus, genCpus, versions, sha, seed, rounds, dur, warmup: f.warmup!,
    conns: sweeping ? [topConn] : usedConns, budgets, defaults: { brustWorkers: insideS === null ? null : Math.min(insideS, 64), tokioThreads: insideS },
    estimateMin, tookMin: Math.round((Date.now() - t0) / 6000) / 10, skipped,
  },
  work,
  cells,
}
const slug = (s: string) => s.toLowerCase().replace(/\(r\)|\(tm\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const outDir = resolve(ROOT, f.out!)
mkdirSync(outDir, { recursive: true })
const base = join(outDir, `${date}-${slug(machine.chip)}-${process.platform}${sweeping ? '-sweep' : ''}`)
await Bun.write(`${base}.json`, `${JSON.stringify(results, null, 2)}\n`)
const md = renderRun(results)
await Bun.write(`${base}.md`, md)
console.log(`\n${md}`)
say(`wrote ${base}.md and .json`)
if (f.publish && !sweeping) {
  await writeResults(resolve(ROOT, 'bench'), legacyResults(results))
  say('published bench/RESULTS.md and RESULTS.json')
}
process.exit(0)

/** Model · chip · RAM; the machine's name is never recorded (repo rule). */
function describeMachine(): Machine {
  const memGb = Math.round(totalmem() / 2 ** 30)
  if (process.platform === 'darwin') {
    const out = Bun.spawnSync(['system_profiler', 'SPHardwareDataType']).stdout.toString()
    const g = (k: string) => new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(out)?.[1]?.trim()
    return { model: g('Model Name') ?? 'mac', chip: g('Chip') ?? g('Processor Name') ?? 'unknown', memGb: Number.parseInt(g('Memory') ?? '', 10) || memGb }
  }
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return ''
    }
  }
  return { model: read('/sys/devices/virtual/dmi/id/product_name').trim() || 'linux', chip: /^model name\s*:\s*(.+)$/m.exec(read('/proc/cpuinfo'))?.[1]?.trim() ?? 'unknown', memGb }
}
