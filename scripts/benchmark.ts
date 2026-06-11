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
  id: string // short id used in column headers, e.g. 'brust'
  label: string // pretty label used in the markdown table
  cmd: string[] // argv to start the server
  env?: Record<string, string> // extra env vars
  expectedPortLog: RegExp // regex with one capture group → port number
}

type Probe = {
  path: string // request path, e.g. '/' or '/ping'
  method?: 'GET' | 'POST' // default GET
  body?: string // request body (POST only)
  contentType?: string // Content-Type header (POST only)
  scenarios?: string[] // restrict probe to scenarios whose id is listed; omit to run on all
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
  ohaRaw: unknown // dropped into RESULTS.json verbatim
}

const CONN = parseInt(process.env.BENCH_CONN ?? '120', 10)
const DURATION = process.env.BENCH_DUR ?? '10s'
const WARMUP_MS = 1000 // boot-settle sleep (worker spawn + registerRenderer)
const WARMUP_BRUST = process.env.BENCH_WARMUP ?? '3s' // discarded JIT warm-up traffic

const SCENARIOS: Scenario[] = [
  {
    id: 'brust',
    label: 'Brust (Rust HTTP + napi + SAB)',
    cmd: ['bun', 'run', 'bench/apps/brust/index.ts'],
    // Default bench config (each overridable by setting the env before `bun run
    // bench`): 14 tokio I/O threads, 6 Bun render workers, 2000 accept permits.
    // NOTE: render workers were once pinned to 18 (the old `* 1.8` default) which
    // oversubscribed CPU-bound React renders and amplified p99 ~6× — see
    // post-mortem 2026-05-28; 6 keeps render workers under the core count.
    env: {
      BRUST_PORT: '38201',
      BRUST_WORKER_THREADS: process.env.BRUST_WORKER_THREADS ?? '4',
      BRUST_WORKERS: process.env.BRUST_WORKERS ?? '6',
      BRUST_CONN_WORKERS: process.env.BRUST_CONN_WORKERS ?? '1024',
      BRUST_RENDER_SLOTS: process.env.BRUST_RENDER_SLOTS ?? '10',
    },
    expectedPortLog: /listening on 127\.0\.0\.1:(\d+)/,
  },
  {
    id: 'bun-serve',
    label: 'Bun.serve + React renderToString',
    cmd: ['bun', 'run', 'bench/apps/bun-serve/index.ts'],
    env: { BUN_BASELINE_PORT: '38202' },
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
  // Native route + L1 response cache. Identical render to /native-profile, but
  // `cache: { ttl_seconds }` makes a hit serve straight from Rust's
  // ResponseCache with ZERO worker dispatch (no napi crossing, no SAB). The
  // bench hits one fixed path, so after the warmup every request is a pure L1
  // hit — the delta vs /native-profile is the whole worker round trip the cache
  // removes. This is the native-zero-Bun cache headline. Brust-only.
  {
    path: '/native-cached/World',
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
  // Same shape as /native-islands, but the ssr island is ISR-CACHED (stable
  // key): renderToString runs once, then every request serves the frozen
  // {html,props} pair from the Rust-side cache. The delta vs /native-islands
  // ≈ the per-request renderToString cost the ISR cache removes. Brust-only.
  {
    path: '/native-islands-isr',
    scenarios: ['brust'],
  },
  // Server-action dispatch — brust-only. REQUIRES `bench/apps/brust/actions.ts`
  // to register the `/notes` endpoint. Without it, the path hits Rust's
  // `error_404` short-circuit at server.rs:272 (unknown endpoint) instead
  // of going through dispatch — measuring the wrong path and reporting
  // ~110k inflated RPS (see commit history for the 2026-05-29 honest-numbers fix).
  // New treaty wire: METHOD <prefix>/<path> with a JSON object body.
  {
    path: '/_brust/action/notes',
    method: 'POST',
    body: '{"text":"hi"}',
    contentType: 'application/json',
    scenarios: ['brust'],
  },
  // Multi-render-per-worker probe — a React SSR route with a per-request
  // async-data <Suspense> (~25ms). The render YIELDS while awaiting its data,
  // so renderSlots>1 overlaps concurrent waits on one worker. Synchronous routes
  // above are unaffected by renderSlots (they serialize on CPU); THIS one scales.
  // Compare two full runs: `bun run bench` (renderSlots=1) vs
  // `BRUST_RENDER_SLOTS=8 bun run bench`. Brust-only.
  {
    path: '/suspense-data',
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
    // `/native-cached` before `/native-profile`? No prefix overlap, but keep the
    // cache row distinct: it serves from Rust's ResponseCache (no worker).
    if (path.startsWith('/native-cached')) return 'Brust (native + L1 cache)'
    if (path.startsWith('/native-profile')) return 'Brust (native jinja)'
    // `-isr` MUST precede the generic `/native-islands` prefix check below
    // (`/native-islands-isr`.startsWith('/native-islands') is true).
    if (path.startsWith('/native-islands-isr')) return 'Brust (native + ISR island)'
    if (path.startsWith('/native-islands')) return 'Brust (native + islands)'
    if (path.startsWith('/_brust/action')) return 'Brust (server action)'
    return 'Brust'
  }
  if (scenarioId === 'bun-serve') {
    if (path === '/') return 'Bun.serve (React SSR)'
    return 'Bun.serve (ping)'
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

  // JIT warm-up brust. A plain sleep warms NOTHING — V8 only JIT-compiles the
  // render path after it has actually served thousands of requests, and a fresh
  // process per probe starts cold. Without this, JIT-heavy paths (React
  // renderToString) are measured mid-ramp and under-report by ~40-60% (cold
  // ~16k vs warm ~25k on /). Fire a real traffic brust and discard it so the
  // measured run sees steady state. Rust paths (ping/native/action) are barely
  // JIT-sensitive, so this only matters for the React SSR rows — but it's
  // applied uniformly to keep every row at steady state.
  try {
    await runOha(url, CONN, WARMUP_BRUST, p)
  } catch {
    // A failed warmup brust shouldn't abort the real measurement; the measured
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
  const summary = ohaJson.summary ?? {}
  const percent = ohaJson.latencyPercentiles ?? {}
  const rps = numberOf(summary.requestsPerSec, summary.requestPerSec) ?? 0
  // oha 1.x does not expose totalRequests in summary; sum statusCodeDistribution instead
  const statusDist = ohaJson.statusCodeDistribution ?? {}
  const totalReq = Object.values(statusDist).reduce(
    (acc: number, v: unknown) => acc + (typeof v === 'number' ? v : 0),
    0,
  )
  // sum all error counts from errorDistribution
  const errDist = ohaJson.errorDistribution ?? {}
  const errors = Object.values(errDist).reduce(
    (acc: number, v: unknown) => acc + (typeof v === 'number' ? v : 0),
    0,
  )
  const p50 = secondsToMs(percent.p50)
  const p95 = secondsToMs(percent.p95)
  const p99 = secondsToMs(percent.p99)

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
    // group 1 is the port digits — present whenever the pattern matches
    // (every `expectedPortLog` regex has a `(\d+)` capture). Capture it into a
    // local so the truthiness guard narrows it to `string` (re-indexing `m[1]`
    // would re-widen to `string | undefined` under noUncheckedIndexedAccess).
    const port = acc.match(pattern)?.[1]
    if (port) {
      reader.releaseLock()
      return parseInt(port, 10)
    }
  }
  reader.releaseLock()
  throw new Error('timed out waiting for listening line')
}

async function runOha(url: string, conn: number, duration: string, probe: Probe): Promise<any> {
  const method = probe.method ?? 'GET'
  const args: string[] = [
    '-c',
    String(conn),
    '-z',
    duration,
    '--no-tui',
    '--output-format',
    'json',
    '-m',
    method,
  ]
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
  } catch (_e) {
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
  lines.push(
    `· warmup: ${WARMUP_MS} ms boot-settle + ${WARMUP_BRUST} discarded JIT brust per probe`,
  )
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
  // A native route with islands (e.g. /native-islands) is handled by
  // emitNativeTemplates, which scans each page's `<Island component={X}>`
  // usage to derive the island chunks, enrich the manifest with sourcePath,
  // and bake the bootstrap — no separate config file needed.
  await emitNativeTemplates({
    entryFile: routesFile,
    flatRoutes,
    outDir,
    repoRoot: REPO_ROOT,
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
      console.log(
        `\n→ ${rowLabel(s.id, p.path)}   ${method} ${p.path}   conn=${CONN}  dur=${DURATION}`,
      )
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
  await writeFile('bench/RESULTS.md', renderMarkdown(results))
  console.log('\nWrote bench/RESULTS.md and bench/RESULTS.json')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
