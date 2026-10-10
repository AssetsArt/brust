// bench/run.ts — M3 bench suite (spec §1). Manual, load-guarded, never in CI.
//   BRUST_RELEASE_ADDON=1 bun run bench                                      # brust, bun-serve, next (01x skipped)
//   BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x bun run bench         # + 0.1.x → F68 line measured
//   bun bench/run.ts --apps brust,next --probes D --dur 3s --enc identity --seed 7
// Flow: guards → build every app → parity (abort on mismatch) → shuffled (app, probe) loop, server restarted per
// pair, 1 s settle + discarded warm-up, identity then gzip → RESULTS.json + RESULTS.md. Exit 0 ok, 1 failure, 2 busy.
import { cpus, hostname, loadavg } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type AppId, type AppSpec, killAllOnExit, startApp } from './lib/app'
import { APP_ORDER, APPS, ROOT } from './lib/apps'
import { evaluateGuards, probeHost } from './lib/guard'
import { acquireHostLock } from './lib/lock'
import { type Encoding, runOha } from './lib/oha'
import { checkParity } from './lib/parity'
import { probe as probeOf, PROBES, type ProbeId } from './lib/probes'
import { mulberry32, shuffle } from './lib/random'
import { type Measurement, type Results, renderVerdict, computeVerdict, writeResults } from './lib/report'

const { values: f } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apps: { type: 'string', default: APP_ORDER.join(',') }, probes: { type: 'string', default: 'S,D,I' },
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

// 3. Parity before any load (spec §1.4): one server per app, three GETs, normalized <main> must match app #1.
const html: Record<ProbeId, { app: string; html: string }[]> = { S: [], D: [], I: [] }
for (const a of apps) {
  const run = await startApp(a, { timeoutMs }).catch((e) => die(1, (e as Error).message))
  try {
    await Bun.sleep(settleMs)
    for (const p of probeIds) {
      const r = await fetch(`${run.base}${probeOf(p).path}`)
      if (r.status !== 200) die(1, `${a.id} ${probeOf(p).path} → HTTP ${r.status}`)
      html[p].push({ app: a.id, html: await r.text() })
    }
  } finally { await run.stop() }
}
for (const p of probeIds) {
  try { await checkParity(html[p], p) } catch (e) { die(1, (e as Error).message) }
  say(`parity ${p}: ${html[p].map((x) => x.app).join(' = ')} ✓`)
}

// Versions are read before the load phase: a failure here must never cost a finished run.
const versions: Record<string, string> = { bun: Bun.version, oha: Bun.spawnSync(['oha', '--version']).stdout.toString().trim().replace(/^oha /, '') }
const nodeV = Bun.spawnSync(['node', '--version']); if (nodeV.exitCode === 0) versions.node = nodeV.stdout.toString().trim()
for (const a of apps) versions[a.id] = await a.version().catch((e: Error) => `? (${e.message})`)

// Host lock (lead rule bench-host-lock): only the load itself is serialised, builds and parity are not.
const releaseLock = await acquireHostLock(say)

// 4. Shuffled measure loop (spec §1.3): app order and probe order from the seed; server restarted per pair.
const rnd = mulberry32(seed)
const pairs = shuffle(apps, rnd).flatMap((a) => shuffle(probeIds, rnd).map((p) => ({ a, p })))
const order = pairs.map(({ a, p }) => `${a.id}:${p}`)
say(`order ${order.join(' ')}`)
const measurements: Measurement[] = []
for (const { a, p } of pairs) {
  const run = await startApp(a, { timeoutMs }).catch((e) => die(1, (e as Error).message))
  try {
    await Bun.sleep(settleMs)
    if (a.sanity) await a.sanity(run.base, p).catch((e) => die(1, (e as Error).message))
    const url = `${run.base}${probeOf(p).path}`
    for (const enc of encs) {
      await runOha(url, { conn, dur: f.warmup!, enc })                       // discarded JIT warm-up
      const { raw, ...nums } = await runOha(url, { conn, dur: f.dur!, enc })
      measurements.push({ app: a.id, probe: p, enc, nums, raw })
      console.log(`  ${a.id.padEnd(10)} ${p} ${enc.padEnd(8)} ${nums.rps.toFixed(0).padStart(7)} rps  p50 ${nums.p50.toFixed(2)} ms  p99 ${nums.p99.toFixed(2)} ms  errors ${nums.errors}`)
    }
  } finally { await run.stop() }
}

releaseLock()

// 5. Report (spec §1.5): numbers only.
const results: Results = {
  header: { date: new Date().toISOString().slice(0, 10), host: `${process.platform}/${process.arch} ${hostname()}`, cores, loadavg: load, seed, conn, dur: f.dur!, warmup: f.warmup!, settleMs, workers: workersN, versions, apps: apps.map((a) => a.id), skipped, order },
  measurements,
}
const outDir = join(ROOT, f.out!)
await writeResults(outDir, results)
console.log(`\n${renderVerdict(computeVerdict(results))}\n`)
say(`wrote ${join(outDir, 'RESULTS.md')} and RESULTS.json`)
process.exit(0)
