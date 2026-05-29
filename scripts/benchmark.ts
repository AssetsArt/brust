// scripts/benchmark.ts
//
// Reproducible benchmark driver. Compares Brust SSR against Bun.serve + React
// renderToString on the same `HelloWorld` component. Writes a markdown summary
// and raw JSON results under bench/.
//
// Usage:
//   bun run bench                  # default: 120 conns, 10 s
//   BENCH_CONN=200 BENCH_DUR=30s bun run bench
//
// Requires `oha` on PATH AND a release-built napi addon:
//   cd runtime && bun run build    # NOT build:debug — debug build is ~2x slower
// The bench process can't tell which build is loaded, so the renderer prints a
// reminder at the top of every run.

import { spawn, spawnSync } from 'bun'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { emitNativeTemplates } from '../runtime/cli/native-routes-emit.ts'

type Scenario = {
  id: string                       // short id used in column headers, e.g. 'brust'
  label: string                    // pretty label used in the markdown table
  cmd: string[]                    // argv to start the server
  env?: Record<string, string>     // extra env vars
  expectedPortLog: RegExp          // regex with one capture group → port number
}

type Probe = {
  path: string                     // request path, e.g. '/' or '/ping'
  method?: 'GET' | 'POST'          // default GET
  body?: string                    // request body (POST only)
  contentType?: string             // Content-Type header (POST only)
  scenarios?: string[]             // restrict probe to scenarios whose id is listed; omit to run on all
}

type Result = {
  scenarioId: string
  scenarioLabel: string
  path: string
  method: 'GET' | 'POST'
  rps: number
  p50ms: number | null
  p95ms: number | null
  p99ms: number | null
  totalRequests: number
  errors: number
  ohaRaw: unknown                  // dropped into RESULTS.json verbatim
}

const CONN     = parseInt(process.env.BENCH_CONN ?? '120', 10)
const DURATION = process.env.BENCH_DUR ?? '10s'
const WARMUP_MS = 1000          // boot-settle sleep (worker spawn + registerRenderer)
const WARMUP_BURST = process.env.BENCH_WARMUP ?? '3s'  // discarded JIT warm-up traffic

const SCENARIOS: Scenario[] = [
  {
    id: 'brust',
    label: 'Brust (Rust HTTP + napi + SAB)',
    cmd: ['bun', 'run', 'bench/apps/brust/index.ts'],
    // No BRUST_WORKERS override — use the runtime default (availableParallelism()).
    // Earlier benches pinned 18 (the old `* 1.8` default) which oversubscribed on
    // CPU-bound React renders and amplified p99 ~6×; see post-mortem 2026-05-28.
    env: { BRUST_PORT: '38201' },
    expectedPortLog: /listening on 127\.0\.0\.1:(\d+)/,
  },
  {
    id: 'bun-serve',
    label: 'Bun.serve + React renderToString',
    cmd: ['bun', 'run', 'bench/apps/bun-serve/index.ts'],
    env: { BUN_BASELINE_PORT: '38202' },
    expectedPortLog: /listening on http:\/\/[^:]+:(\d+)/,
  },
  {
    id: 'elysia',
    label: 'Elysia + React renderToString',
    cmd: ['bun', 'run', 'bench/apps/elysia/index.ts'],
    env: { ELYSIA_PORT: '38203' },
    expectedPortLog: /listening on http:\/\/[^:]+:(\d+)/,
  },
]

const PROBES: Probe[] = [
  { path: '/ping' },
  { path: '/' },
  // Sub-project J — `native: true` route. Compiled to jinja at build time,
  // rendered Rust-side via minijinja with loader-supplied template context.
  // Goes through `dispatch_to_worker_and_stream_chunks` like every JS-bridged
  // path; comparable cost to actions and React no-Suspense routes.
  // Brust-only — no bun-serve equivalent.
  {
    path: '/native-profile/World',
    scenarios: ['brust'],
  },
  // Sub-project J / Phase A3 — native: true route WITH islands. Same jinja
  // fast lane as /native-profile, plus per-island work in the SAME loader
  // crossing: one CLIENT-ONLY island (a props string, ~free server-side) and
  // one SERVER island (`renderToString`'d in the worker). The delta vs
  // /native-profile ≈ the ssr island's renderToString cost (the client-only
  // island adds only an entity-encoded props string). No new napi crossing.
  // Brust-only.
  {
    path: '/native-islands',
    scenarios: ['brust'],
  },
  // Server-function dispatch — brust-only. REQUIRES `bench/apps/brust/actions.ts`
  // to actually register createNote. Without it, the path hits Rust's
  // `error_404` short-circuit at server.rs:272 (unknown action id) instead
  // of going through dispatch — measuring the wrong path and reporting
  // ~110k inflated RPS (see commit history for the 2026-05-29 honest-numbers fix).
  {
    path: '/_brust/action/createNote',
    method: 'POST',
    body: '["hi"]',
    contentType: 'application/json',
    scenarios: ['brust'],
  },
]

// Per-(scenario, path) display label for the markdown table. The static
// scenario `label` describes the server build; this names the engine/path each
// row actually exercises, so `/ping` (pure Rust, no worker) isn't lumped under
// the same "napi + SAB" tag as the routes that genuinely cross into a worker.
function rowLabel(scenarioId: string, path: string): string {
  if (scenarioId === 'brust') {
    if (path === '/ping') return 'Brust (Rust only)'
    if (path === '/') return 'Brust (React SSR)'
    if (path.startsWith('/native-profile')) return 'Brust (native jinja)'
    if (path.startsWith('/native-islands')) return 'Brust (native + islands)'
    if (path.startsWith('/_brust/action')) return 'Brust (server action)'
    return 'Brust'
  }
  if (scenarioId === 'bun-serve') {
    if (path === '/') return 'Bun.serve (React SSR)'
    return 'Bun.serve (ping)'
  }
  if (scenarioId === 'elysia') {
    if (path === '/') return 'Elysia (React SSR)'
    return 'Elysia (ping)'
  }
  return scenarioId
}

async function runScenario(s: Scenario, p: Probe): Promise<Result> {
  const proc = spawn({
    cmd: s.cmd,
    env: { ...process.env, ...(s.env ?? {}) },
    stdout: 'pipe',
    stderr: 'inherit',
  })

  let port: number
  try {
    port = await readPort(proc.stdout, s.expectedPortLog)
  } catch (e) {
    proc.kill('SIGKILL')
    throw new Error(`[${s.id}] failed to read port line: ${(e as Error).message}`)
  }

  const url = `http://127.0.0.1:${port}${p.path}`

  // Boot settle — let the worker pool finish spawning + registerRenderer.
  await new Promise((r) => setTimeout(r, WARMUP_MS))

  // JIT warm-up burst. A plain sleep warms NOTHING — V8 only JIT-compiles the
  // render path after it has actually served thousands of requests, and a fresh
  // process per probe starts cold. Without this, JIT-heavy paths (React
  // renderToString) are measured mid-ramp and under-report by ~40-60% (cold
  // ~16k vs warm ~25k on /). Fire a real traffic burst and discard it so the
  // measured run sees steady state. Rust paths (ping/native/action) are barely
  // JIT-sensitive, so this only matters for the React SSR rows — but it's
  // applied uniformly to keep every row at steady state.
  try {
    await runOha(url, CONN, WARMUP_BURST, p)
  } catch {
    // A failed warmup burst shouldn't abort the real measurement; the measured
    // run below will surface any genuine error.
  }

  let ohaJson: any
  try {
    ohaJson = await runOha(url, CONN, DURATION, p)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }

  // oha JSON shape (1.x):
  //   summary.requestsPerSec      number
  //   latencyPercentiles.p50      seconds (fractional)
  //   latencyPercentiles.p95      seconds
  //   latencyPercentiles.p99      seconds
  //   statusCodeDistribution      Record<string, number>  (sum = total requests)
  //   errorDistribution           Record<string, number>
  const summary  = ohaJson.summary ?? {}
  const percent  = ohaJson.latencyPercentiles ?? {}
  const rps      = numberOf(summary.requestsPerSec, summary.requestPerSec) ?? 0
  // oha 1.x does not expose totalRequests in summary; sum statusCodeDistribution instead
  const statusDist = ohaJson.statusCodeDistribution ?? {}
  const totalReq = Object.values(statusDist).reduce(
    (acc: number, v: unknown) => acc + (typeof v === 'number' ? v : 0),
    0,
  )
  // sum all error counts from errorDistribution
  const errDist = ohaJson.errorDistribution ?? {}
  const errors   = Object.values(errDist).reduce(
    (acc: number, v: unknown) => acc + (typeof v === 'number' ? v : 0),
    0,
  )
  const p50      = secondsToMs(percent.p50)
  const p95      = secondsToMs(percent.p95)
  const p99      = secondsToMs(percent.p99)

  return {
    scenarioId: s.id,
    scenarioLabel: rowLabel(s.id, p.path),
    path: p.path,
    method: p.method ?? 'GET',
    rps,
    p50ms: p50,
    p95ms: p95,
    p99ms: p99,
    totalRequests: totalReq,
    errors,
    ohaRaw: ohaJson,
  }
}

async function readPort(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) throw new Error('server closed stdout before listening line')
    acc += decoder.decode(value, { stream: true })
    const m = acc.match(pattern)
    if (m) {
      reader.releaseLock()
      return parseInt(m[1], 10)
    }
  }
  reader.releaseLock()
  throw new Error('timed out waiting for listening line')
}

async function runOha(url: string, conn: number, duration: string, probe: Probe): Promise<any> {
  const method = probe.method ?? 'GET'
  const args: string[] = ['-c', String(conn), '-z', duration, '--no-tui', '--output-format', 'json', '-m', method]
  if (method === 'POST') {
    if (!probe.body) throw new Error('POST probe requires body')
    args.push('-d', probe.body)
    if (probe.contentType) args.push('-T', probe.contentType)
  }
  args.push(url)
  const oha = spawn({
    cmd: ['oha', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(oha.stdout).text(),
    new Response(oha.stderr).text(),
  ])
  const exitCode = await oha.exited
  if (exitCode !== 0) {
    throw new Error(`oha exited ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout.slice(0, 200)}`)
  }
  try {
    return JSON.parse(stdout)
  } catch (e) {
    throw new Error(`oha did not return JSON. stdout head: ${stdout.slice(0, 200)}`)
  }
}

function numberOf(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
  }
  return null
}

function secondsToMs(sec: unknown): number | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return null
  return sec * 1000
}

function renderMarkdown(results: Result[]): string {
  const date = new Date().toISOString().slice(0, 10)
  const hardware = `${process.platform}/${process.arch}`
  const node = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : 'Bun ?'
  const lines: string[] = []
  lines.push(`# Brust benchmarks — ${date}`)
  lines.push('')
  lines.push(`**Conditions:** \`oha -c ${CONN} -z ${DURATION} --no-tui --output-format json\``)
  lines.push(`· runtime: ${node}`)
  lines.push(`· host: ${hardware}`)
  lines.push(`· warmup: ${WARMUP_MS} ms boot-settle + ${WARMUP_BURST} discarded JIT burst per probe`)
  lines.push(`· build: release (\`cd runtime && bun run build\`)`)
  lines.push('')
  // Note on omitted columns: oha's `errorDistribution` counts requests that
  // didn't complete before `-z` elapsed (in-flight at the deadline) — that's
  // a duration-boundary truncation, NOT actual HTTP/connection failures. The
  // raw count is still in RESULTS.json under `errors` if anyone needs it.
  lines.push('| Scenario | Method | Path | RPS | p50 (ms) | p95 (ms) | p99 (ms) | Total |')
  lines.push('|---|---|---|---:|---:|---:|---:|---:|')
  for (const r of results) {
    const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(2))
    lines.push(
      `| ${r.scenarioLabel} | ${r.method} | \`${r.path}\` | ${Math.round(r.rps).toLocaleString()} | ` +
      `${fmt(r.p50ms)} | ${fmt(r.p95ms)} | ${fmt(r.p99ms)} | ` +
      `${r.totalRequests.toLocaleString()} |`,
    )
  }
  lines.push('')
  lines.push('Generated by `bun run bench` — see `scripts/benchmark.ts`.')
  return lines.join('\n') + '\n'
}

async function preflightJinja(): Promise<void> {
  // Sub-project J — emit .brust/jinja/<Name>.jinja for the brust bench app's
  // native: true routes BEFORE the brust scenario boots. Runtime loads from
  // process.cwd() + '.brust/jinja', and `bun run bench/apps/brust/index.ts`
  // runs with cwd = repo root, so emit to <repo>/.brust/jinja.
  //
  // Without this, /native-profile/{user} 500s because the registry is empty.
  const REPO_ROOT = process.cwd()
  const benchAppDir = path.resolve(REPO_ROOT, 'bench/apps/brust')
  const routesFile = path.join(benchAppDir, 'routes.tsx')
  if (!existsSync(routesFile)) {
    console.warn('[bench] pre-flight: no routes.tsx in bench/apps/brust — skipping jinja emit')
    return
  }
  // Ensure jsx-rustc binary exists (release preferred). emitNativeTemplates
  // throws clearly if it's missing AND there are native routes to emit.
  const jsxRustcDebug = path.join(REPO_ROOT, 'target/debug/jsx-rustc')
  const jsxRustcRelease = path.join(REPO_ROOT, 'target/release/jsx-rustc')
  if (!existsSync(jsxRustcDebug) && !existsSync(jsxRustcRelease)) {
    console.log('[bench] pre-flight: building jsx-rustc')
    const r = spawnSync({
      cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
      cwd: REPO_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (r.exitCode !== 0) throw new Error('cargo build -p jsx-rust-compiler --bin jsx-rustc failed')
  }
  const mod = await import(routesFile)
  const flatRoutes = (mod.routes ?? []) as { nativeTemplate?: string }[]
  const outDir = path.resolve(REPO_ROOT, '.brust/jinja')
  // A native route with islands (e.g. /native-islands) requires the island
  // config so emitNativeTemplates can validate ids, enrich the manifest with
  // sourcePath, and bake the bootstrap. Without it, emit THROWS on that route.
  const islandConfig = path.join(benchAppDir, 'island.config.ts')
  await emitNativeTemplates({
    entryFile: routesFile,
    flatRoutes,
    outDir,
    repoRoot: REPO_ROOT,
    islandConfigPath: existsSync(islandConfig) ? islandConfig : undefined,
  })
  const builtCount = flatRoutes.filter((r) => r.nativeTemplate).length
  console.log(`[bench] pre-flight: emitted ${builtCount} jinja template(s) → ${outDir}`)
}

async function main() {
  console.log(
    'Reminder: bench requires a release-built napi addon.\n' +
    '  cd runtime && bun run build     # release, optimised\n' +
    '  cd runtime && bun run build:debug   # ~2x slower, debug only\n',
  )
  await preflightJinja()
  const results: Result[] = []
  for (const s of SCENARIOS) {
    for (const p of PROBES) {
      if (p.scenarios && !p.scenarios.includes(s.id)) continue
      const method = p.method ?? 'GET'
      console.log(`\n→ ${rowLabel(s.id, p.path)}   ${method} ${p.path}   conn=${CONN}  dur=${DURATION}`)
      const r = await runScenario(s, p)
      results.push(r)
      console.log(
        `  rps=${r.rps.toFixed(0).padStart(7)}   ` +
        `p50=${(r.p50ms ?? NaN).toFixed(2)}ms   ` +
        `p99=${(r.p99ms ?? NaN).toFixed(2)}ms   ` +
        `total=${r.totalRequests.toLocaleString()}`,
      )
    }
  }

  await mkdir('bench', { recursive: true })
  await writeFile('bench/RESULTS.json', JSON.stringify(results, null, 2))
  await writeFile('bench/RESULTS.md',   renderMarkdown(results))
  console.log('\nWrote bench/RESULTS.md and bench/RESULTS.json')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
