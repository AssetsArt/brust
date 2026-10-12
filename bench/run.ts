// bench/run.ts — M3 bench suite (spec §1). Manual, load-guarded, never in CI.
//   BRUST_RELEASE_ADDON=1 bun run bench                                      # brust, bun-serve, next, elysia-bun (01x skipped)
//   BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x bun run bench         # + 0.1.x → F68 line measured
//   bun bench/run.ts --apps brust,next --probes D --dur 3s --enc identity --seed 7
// Flow: guards → build every app → parity (abort on mismatch) → shuffled (app, probe) loop, server restarted per
// pair, 1 s settle + discarded warm-up, identity then gzip (A probes: identity only, at c=120 and c=1) → RESULTS.json + RESULTS.md. Exit 0 ok, 1 failure, 2 busy.
import { cpus, hostname, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type AppId, type AppSpec, killAllOnExit, startApp } from './lib/app'
import { APP_ORDER, APPS, ROOT } from './lib/apps'
import { evaluateGuards, probeHost } from './lib/guard'
import { acquireHostLock } from './lib/lock'
import { type Encoding, runOha, validateRun } from './lib/oha'
import { checkBalance } from './lib/balance'
import { checkJsonParity, checkParity, type JsonResponse } from './lib/parity'
import { probe as probeOf, type ProbeId, serves } from './lib/probes'
import { mulberry32, shuffle } from './lib/random'
import { type ActionsHeader, computeActionsVerdict, computeVerdict, type Measurement, type Results, renderActionsVerdict, renderVerdict, writeResults } from './lib/report'
import data from './apps/_shared/data.json'

const { values: f } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apps: { type: 'string', default: APP_ORDER.join(',') }, probes: { type: 'string', default: 'S,D,I,A1,A2' },
    conn: { type: 'string', default: '120' }, dur: { type: 'string', default: '10s' }, warmup: { type: 'string', default: '3s' },
    settle: { type: 'string', default: '1000' }, enc: { type: 'string', default: 'both' }, seed: { type: 'string' },
    out: { type: 'string', default: 'bench' }, workers: { type: 'string' }, timeout: { type: 'string', default: '60000' },
  },
})
const say = (s: string) => console.log(`[bench] ${s}`)
const die = (code: 1 | 2, s: string): never => { console.error(`[bench] ${s}`); process.exit(code) }

const appIds = f.apps!.split(',').map((s) => s.trim()).filter(Boolean) as AppId[]
for (const a of appIds) if (!(a in APPS)) die(1, `unknown app ${a} (choose from ${APP_ORDER.join(', ')})`)
const probeIds = f.probes!.split(',').map((s) => s.trim()).filter(Boolean) as ProbeId[]
for (const p of probeIds) probeOf(p)
const encs: Encoding[] = f.enc === 'both' ? ['identity', 'gzip'] : f.enc === 'identity' || f.enc === 'gzip' ? [f.enc] : die(1, `--enc must be identity|gzip|both`)
const conn = Number.parseInt(f.conn!, 10)
const settleMs = Number.parseInt(f.settle!, 10)
const timeoutMs = Number.parseInt(f.timeout!, 10)
const seed = f.seed !== undefined ? Number.parseInt(f.seed, 10) : Date.now() % 1_000_000_000
if (!Number.isInteger(seed) || !Number.isInteger(conn) || conn < 1 || !Number.isInteger(settleMs) || !Number.isInteger(timeoutMs)) die(1, `--seed/--conn/--settle/--timeout must be integers (got seed ${f.seed}, conn ${f.conn})`)
if (f.workers) process.env.BENCH_WORKERS = f.workers
const cores = cpus().length
const workersN = Number.parseInt(process.env.BENCH_WORKERS ?? String(cores), 10)

// 1. Guards (spec §1.3): busy host → 2; missing tool/declaration → 1. No flag skips them.
const skipped: { app: AppId; reason: string }[] = []
const apps: AppSpec[] = []
for (const id of appIds) {
  const av = APPS[id].available()
  if (av.ok) apps.push(APPS[id])
  else { skipped.push({ app: id, reason: av.reason }); say(`${id}: skipped (${av.reason})`) }
}
const g = evaluateGuards(probeHost({ needNode: apps.some((a) => a.id === 'next'), needBrustAddon: apps.some((a) => a.id === 'brust') }))
if (!g.ok) die(g.code, g.reason)
const load = loadavg().map((l) => Math.round(l * 100) / 100)
say(`load average ${load.join(' ')} (${cores} cores) · seed ${seed} · apps ${apps.map((a) => a.id).join(',')} · probes ${probeIds.join(',')} · enc ${encs.join('+')}`)
killAllOnExit()

// 2. Build every app (production mode, spec §1.3).
for (const a of apps) {
  say(`build ${a.id} …`)
  try { await a.build((s) => { if (s) console.log(s.split('\n').map((l) => `  ${l}`).join('\n')) }) } catch (e) { die(1, `build ${a.id} failed: ${(e as Error).message}`) }
}

// 3. Parity before any load (spec §1.4): one server per app, GETs of the probes it serves. Pages: normalized <main>
// must match app #1; A probes: equal parsed JSON (and equal to the expected value).
const pageProbes = probeIds.filter((p) => probeOf(p).kind === 'page')
const jsonProbes = probeIds.filter((p) => probeOf(p).kind === 'json')
const html: Partial<Record<ProbeId, { app: string; html: string }[]>> = {}
const json: Partial<Record<ProbeId, JsonResponse[]>> = {}
const EXPECTED: Partial<Record<ProbeId, unknown>> = { A1: data.types, A2: { ok: true, id: 25 } }
const request = (base: string, p: ProbeId) => {
  const pr = probeOf(p)
  return fetch(`${base}${pr.path}`, pr.method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: pr.body } : undefined)
}
for (const a of apps) {
  const mine = probeIds.filter((p) => serves(a.id, p))
  if (mine.length === 0) continue
  const run = await startApp(a, { timeoutMs }).catch((e) => die(1, (e as Error).message))
  try {
    await Bun.sleep(settleMs)
    for (const p of mine) {
      const r = await request(run.base, p)
      if (probeOf(p).kind === 'page') {
        if (r.status !== 200) die(1, `${a.id} ${probeOf(p).path} → HTTP ${r.status}`)
        ;(html[p] ??= []).push({ app: a.id, html: await r.text() })
      } else (json[p] ??= []).push({ app: a.id, status: r.status, contentType: r.headers.get('content-type'), body: await r.text() })
    }
  } finally { await run.stop() }
}
for (const p of pageProbes) {
  const pages = html[p] ?? []
  try { await checkParity(pages, p) } catch (e) { die(1, (e as Error).message) }
  say(`parity ${p}: ${pages.map((x) => x.app).join(' = ')} ✓`)
}
for (const p of jsonProbes) {
  const rs = json[p] ?? []
  try { await checkJsonParity(rs, p, EXPECTED[p]) } catch (e) { die(1, (e as Error).message) }
  say(`parity ${p}: ${rs.map((x) => x.app).join(' = ')} ✓`)
}

// Builds loaded the host: re-check the guards right before the load phase (1- and 5-minute averages).
const g2 = evaluateGuards(probeHost({ needNode: apps.some((a) => a.id === 'next'), needBrustAddon: apps.some((a) => a.id === 'brust') }))
if (!g2.ok) die(g2.code, `after builds: ${g2.reason}`)

// Versions are read before the load phase: a failure here must never cost a finished run.
const versions: Record<string, string> = { bun: Bun.version, oha: Bun.spawnSync(['oha', '--version']).stdout.toString().trim().replace(/^oha /, '') }
const nodeV = Bun.spawnSync(['node', '--version']); if (nodeV.exitCode === 0) versions.node = nodeV.stdout.toString().trim()
for (const a of apps) versions[a.id] = await a.version().catch((e: Error) => `? (${e.message})`)

// Host lock (lead rule bench-host-lock): only the load itself is serialised, builds and parity are not.
const releaseLock = await acquireHostLock(say)

// 4. Shuffled measure loop (spec §1.3): probe order and app order from the seed; server restarted per pair. Each probe
// is measured only on the apps that serve it (Probe.apps); no pair at all is a usage error.
const rnd = mulberry32(seed)
// Interleaved: probes in seeded order, apps shuffled within each probe, so host drift lands across apps, not on one.
const pairs = shuffle(probeIds, rnd).flatMap((p) => shuffle(apps.filter((a) => serves(a.id, p)), rnd).map((a) => ({ a, p })))
if (pairs.length === 0) die(1, `no (app, probe) pair to measure: apps ${apps.map((a) => a.id).join(',') || '(none)'} serve none of probes ${probeIds.join(',')} (A1/A2 run on brust and elysia-bun only; S/D/I on brust, bun-serve, next, brust-01x)`)
const order = pairs.map(({ a, p }) => `${a.id}:${p}`)
say(`order ${order.join(' ')}`)
const measurements: Measurement[] = []
const actionMeasurements: Measurement[] = []
let bunServeBalanced: boolean | null = null
let elysiaBunBalanced: boolean | null = null
const noteBalance = async (a: AppSpec, p: ProbeId) => {
  if (!a.distribution) return
  const b = checkBalance(await a.distribution().catch(() => []))
  if (a.id === 'bun-serve') bunServeBalanced = (bunServeBalanced ?? true) && b.ok
  if (a.id === 'elysia-bun') elysiaBunBalanced = (elysiaBunBalanced ?? true) && b.ok
  say(`${a.id} ${p}: per-process requests ${b.counts.join('/')} (min share ${(b.minShare * 100).toFixed(1)}%) ${b.ok ? 'balanced' : '— 1-proc (reusePort did not balance)'}`)
}
for (const { a, p } of pairs) {
  const run = await startApp(a, { timeoutMs }).catch((e) => die(1, (e as Error).message))
  try {
    await Bun.sleep(settleMs)
    if (a.sanity) await a.sanity(run.base, p).catch((e) => die(1, (e as Error).message))
    const pr = probeOf(p)
    const url = `${run.base}${pr.path}`
    if (pr.kind === 'page') {
      for (const enc of encs) {
        await runOha(url, { conn, dur: f.warmup!, enc })                       // discarded JIT warm-up
        const { raw, ...nums } = await runOha(url, { conn, dur: f.dur!, enc })
        try { validateRun(nums, `${a.id} ${p} ${enc}`) } catch (e) { die(1, (e as Error).message) }
        measurements.push({ app: a.id, probe: p, enc, nums, raw })
        console.log(`  ${a.id.padEnd(10)} ${p} ${enc.padEnd(8)} ${nums.rps.toFixed(0).padStart(7)} rps  p50 ${nums.p50.toFixed(2)} ms  p99 ${nums.p99.toFixed(2)} ms  errors ${nums.errors}`)
      }
      await noteBalance(a, p)
    } else {
      // A probes: identity only, at c=<conn> then c=1. Balance is read after the high-c row and before c=1: one connection always lands on one process.
      for (const c of [conn, 1]) {
        const o = { conn: c, dur: f.warmup!, enc: 'identity' as Encoding, method: pr.method, ...(pr.body !== undefined ? { body: pr.body } : {}) }
        await runOha(url, o)                                                    // discarded warm-up at this c
        const { raw, ...nums } = await runOha(url, { ...o, dur: f.dur! })
        try { validateRun(nums, `${a.id} ${p} c=${c}`) } catch (e) { die(1, (e as Error).message) }
        actionMeasurements.push({ app: a.id, probe: p, enc: 'identity', conn: c, nums, raw })
        console.log(`  ${a.id.padEnd(10)} ${p} c=${String(c).padEnd(5)} ${nums.rps.toFixed(0).padStart(7)} rps  p50 ${nums.p50.toFixed(3)} ms  p99 ${nums.p99.toFixed(3)} ms  errors ${nums.errors}`)
        if (c === conn) await noteBalance(a, p)
      }
    }
  } finally { await run.stop() }
}

releaseLock()

// 5. Report (spec §1.5): numbers only. Two blocks (R4): the page block lists only apps that served a measured page
// probe, the actions block only apps that served an A probe; writeResults merges into the RESULTS.json already there.
const budgetOf = (a: AppSpec) => (a.id === 'next' ? 'procs=1 (as shipped)' : a.id === 'bun-serve' || a.id === 'elysia-bun' ? `procs=${workersN}` : `workers=${workersN}`)
const date = new Date().toISOString().slice(0, 10)
const host = `${process.platform}/${process.arch} ${hostname()}`
const pageApps = apps.filter((a) => pageProbes.some((p) => serves(a.id, p)))
const actionApps = apps.filter((a) => jsonProbes.some((p) => serves(a.id, p)))
const ofApps = (xs: AppSpec[]) => Object.fromEntries(xs.map((a) => [a.id, budgetOf(a)]))
const pick = (xs: AppSpec[]) => Object.fromEntries(Object.entries(versions).filter(([k]) => ['bun', 'oha', 'node'].includes(k) || xs.some((a) => a.id === k)))
const orderOf = (kind: 'page' | 'json') => pairs.filter(({ p }) => probeOf(p).kind === kind).map(({ a, p }) => `${a.id}:${p}`)
const actions: { header: ActionsHeader; measurements: Measurement[] } | undefined = jsonProbes.length > 0 && actionApps.length > 0
  ? { header: { date, host, cores, loadavg: load, seed, conns: [conn, 1], dur: f.dur!, warmup: f.warmup!, settleMs, workers: workersN, versions: pick(actionApps), apps: actionApps.map((a) => a.id), skipped, order: orderOf('json'), budgets: ofApps(actionApps), elysiaBunBalanced }, measurements: actionMeasurements }
  : undefined
const results: Results = {
  header: { date, host, cores, loadavg: load, seed, conn, dur: f.dur!, warmup: f.warmup!, settleMs, workers: workersN, versions: pick(pageApps), apps: pageApps.map((a) => a.id), skipped, order: orderOf('page'), budgets: ofApps(pageApps), bunServeBalanced },
  measurements,
  ...(actions ? { actions } : {}),
}
const outDir = resolve(ROOT, f.out!)
await writeResults(outDir, results, { page: measurements.length > 0, actions: actionMeasurements.length > 0 })
console.log(`\n${measurements.length > 0 ? `${renderVerdict(computeVerdict(results))}\n` : ''}${actions ? `${renderActionsVerdict(computeActionsVerdict(results))}\n` : ''}`)
say(`wrote ${join(outDir, 'RESULTS.md')} and RESULTS.json`)
process.exit(0)
