// bench/run.ts — three probes on v2 examples/pokedex and on the 0.1.x example/pokedex (BRUST_01X_DIR). Manual.
//   bun run bench                                   # v2 only → bar: not measured
//   BRUST_01X_DIR=/Users/detoro/code/brust bun run bench
// Requires: oha on PATH; a RELEASE addon in packages/brust/native (cd packages/brust && bun run build); for the
// 0.1.x side: its release addon (cd $BRUST_01X_DIR/runtime && bun run build) and its pokedex built
// (bun run runtime/cli/index.ts build example/pokedex/index.ts). The 0.1.x loaders hit PokeAPI on the first
// request per name: the warm-up GETs every name once on BOTH apps before measuring (network needed for 0.1.x only).
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import snap from '../examples/pokedex/data/pokedex.json'

const ROOT = resolve(import.meta.dir, '..')
const CONN = Number.parseInt(process.env.BENCH_CONN ?? '120', 10)
const DUR = process.env.BENCH_DUR ?? '10s'
const WARMUP = process.env.BENCH_WARMUP ?? '3s'
const NAMES = snap.pokemon.map((p) => p.name)
type Nums = { rps: number; p50: number; p95: number; p99: number; total: number }
type Probe = { id: string; path: string; regex?: (base: string, nocache: boolean) => string }
const PROBES: Probe[] = [
  { id: 'A-static-hit', path: '/type-chart' },
  { id: 'B-native-miss', path: '/pokemon/{name}', regex: (base, nocache) => `${base}/pokemon/(${NAMES.join('|')})${nocache ? '\\?nocache=1' : ''}` },
  { id: 'C-react-child', path: '/' },
]

function need(cond: boolean, msg: string): void { if (!cond) { console.error(`[bench] ${msg}`); process.exit(1) } }
need(Bun.spawnSync(['oha', '--version']).exitCode === 0, 'oha not on PATH (cargo install oha)')
const native = join(ROOT, 'packages/brust/native')
need(existsSync(native) && readdirSync(native).some((f) => f.endsWith('.node')), 'no addon: cd packages/brust && bun run build (RELEASE)')
need(process.env.BRUST_RELEASE_ADDON === '1', 'set BRUST_RELEASE_ADDON=1 to assert you built with `bun run build`, not build:debug (the bench cannot tell)')

async function waitFor(proc: ReturnType<typeof Bun.spawn>, re: RegExp): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader(); const dec = new TextDecoder(); let out = ''
  for (;;) { const { done, value } = await reader.read(); if (done) throw new Error(`exited:\n${out}`); out += dec.decode(value, { stream: true }); const m = re.exec(out); if (m) { void (async () => { for (;;) { const r = await reader.read(); if (r.done) return } })(); return m[1]! } }
}
async function startV2(): Promise<{ base: string; stop: () => void }> {
  const app = join(ROOT, 'examples/pokedex'); const bin = join(ROOT, 'packages/brust/bin/brust')
  need(Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app }).exitCode === 0, 'v2 build failed')
  const p = Bun.spawn([bin, 'start', '--port', '38201', '--workers', process.env.BRUST_WORKERS ?? '6'], { cwd: app, env: { ...process.env, BRUST_PORT: '', RUST_LOG: 'warn' }, stdout: 'pipe', stderr: 'inherit' })
  await waitFor(p, /\[brust\] ready/)
  return { base: 'http://127.0.0.1:38201', stop: () => p.kill('SIGINT') }
}
async function start01x(dir: string): Promise<{ base: string; stop: () => void }> {
  need(readdirSync(join(dir, 'runtime')).some((f) => f.endsWith('.node')), `0.1.x addon missing in ${dir}/runtime (cd runtime && bun run build)`)
  const p = Bun.spawn(['bun', 'run', 'example/pokedex/index.ts'], { cwd: dir, env: { ...process.env, BRUST_PORT: '38202', BRUST_WORKERS: process.env.BRUST_WORKERS ?? '6', RUST_LOG: 'brust=warn' }, stdout: 'pipe', stderr: 'inherit' })
  const port = await waitFor(p, /listening on 127\.0\.0\.1:(\d+)/)
  return { base: `http://127.0.0.1:${port}`, stop: () => p.kill('SIGINT') }
}
async function warm(base: string): Promise<void> {        // every name once (0.1.x fetches PokeAPI here), then the fixed paths
  for (const n of NAMES) await fetch(`${base}/pokemon/${n}`)
  for (const p of ['/', '/type-chart']) for (let i = 0; i < 3; i++) await fetch(`${base}${p}`)
}
async function oha(args: string[]): Promise<Nums> {
  const p = Bun.spawn(['oha', '-c', String(CONN), '--no-tui', '--output-format', 'json', '-m', 'GET', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  need((await p.exited) === 0, `oha failed: ${err}`)
  const j = JSON.parse(out)
  return { rps: j.summary.requestsPerSec, p50: j.latencyPercentiles.p50 * 1000, p95: j.latencyPercentiles.p95 * 1000, p99: j.latencyPercentiles.p99 * 1000, total: j.summary.total }
}
async function measure(base: string, probe: Probe, nocache: boolean): Promise<Nums> {
  const target = probe.regex ? ['--rand-regex-url', probe.regex(base, nocache)] : [`${base}${probe.path}`]
  await oha(['-z', WARMUP, ...target])                        // discarded JIT warm-up (0.1.x rule)
  return oha(['-z', DUR, ...target])
}

const v2 = await startV2(); await warm(v2.base)
const dir01 = process.env.BRUST_01X_DIR
const x01 = dir01 ? await start01x(dir01) : null; if (x01) await warm(x01.base)
const probes = []
for (const pr of PROBES) {
  const a = await measure(v2.base, pr, true)
  const b = x01 ? await measure(x01.base, pr, false) : null
  probes.push({ id: pr.id, path: pr.path, v2: a, x01: b, deltaRpsPct: b ? Math.round(((a.rps - b.rps) / b.rps) * 1000) / 10 : null })
  console.log(`${pr.id.padEnd(16)} v2 ${a.rps.toFixed(0).padStart(7)} rps${b ? `   0.1.x ${b.rps.toFixed(0).padStart(7)} rps   Δ ${probes.at(-1)!.deltaRpsPct}%` : ''}`)
}
v2.stop(); x01?.stop()
const bar = !x01 ? 'not measured' : probes.every((p) => p.v2.rps >= p.x01!.rps) ? 'met' : 'not met'
const result = { date: new Date().toISOString().slice(0, 10), host: `${process.platform}/${process.arch}`, bun: Bun.version, conn: CONN, dur: DUR, warmup: WARMUP, addon: 'release', bar, probes }
writeFileSync(join(ROOT, 'bench/RESULTS.json'), `${JSON.stringify(result, null, 2)}\n`)
const f = (n: number) => n.toFixed(2)
const md = [`# M2 bench — ${result.date}`, '', `**Conditions:** \`oha -c ${CONN} -z ${DUR}\` · warm-up ${WARMUP} discarded · Bun ${Bun.version} · host ${result.host} · release addon · workers ${process.env.BRUST_WORKERS ?? '6'}`, '',
  '| Probe | Path | v2 rps | v2 p50 | v2 p99 | 0.1.x rps | 0.1.x p50 | 0.1.x p99 | Δ rps |', '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...probes.map((p) => `| ${p.id} | \`${p.path}\` | ${Math.round(p.v2.rps).toLocaleString()} | ${f(p.v2.p50)} | ${f(p.v2.p99)} | ${p.x01 ? Math.round(p.x01.rps).toLocaleString() : '—'} | ${p.x01 ? f(p.x01.p50) : '—'} | ${p.x01 ? f(p.x01.p99) : '—'} | ${p.deltaRpsPct === null ? '—' : `${p.deltaRpsPct}%`} |`),
  '', `**Bar (v2 not slower on any probe): ${bar}.** A = L1 HIT on v2 / full render on 0.1.x (no cache there); B = L1 bypassed on v2 (\`?nocache=1\`), loader every request, jobs from the job cache; C = page with the TeamBuilder react child on both.`, '', 'Generated by `bun run bench` — see `bench/run.ts`. macOS numbers are not Linux numbers.', '']
writeFileSync(join(ROOT, 'bench/RESULTS.md'), md.join('\n'))
console.log(`bar: ${bar} — wrote bench/RESULTS.{md,json}`)
