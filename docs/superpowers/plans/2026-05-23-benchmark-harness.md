# Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible benchmark driver that boots each candidate server (Brust SSR, Bun.serve baseline), runs `oha` against `/` and `/ping`, parses the JSON results, and writes a markdown summary table to `bench/RESULTS.md`. Single command (`bun run bench`) end-to-end.

**Architecture:** TS script `scripts/benchmark.ts` runs each scenario sequentially using `Bun.spawn`. For each scenario it: (1) starts the target server, (2) reads its `listening on …:PORT` line from stdout, (3) sleeps 1 s to warm caches, (4) runs `oha -c <conn> -z <duration> --no-tui --json http://127.0.0.1:<port><path>` and captures stdout, (5) kills the server with `SIGINT` and awaits exit, (6) parses `oha`'s JSON into a small `Result` record. After all scenarios finish, the script renders one markdown table and writes it to `bench/RESULTS.md`, also dumping the raw JSON to `bench/RESULTS.json` for later inspection.

**Tech Stack:** Bun 1.3, TypeScript, `oha` (external binary — installed via `brew install oha` or `cargo install oha`), existing Brust + Bun.serve baseline servers. No new runtime dependencies; uses only Bun built-ins.

**Spec source:** Architecture mentions `Bun.serve baseline comparator: example/bun-serve-baseline/index.ts` already lands and notes `*TBD*` for `/`, `/ping` numbers. Handoff line: `Benchmark harness — ~1 d — validate the whole premise; cheap.` Final-review consensus also pegs this as the cheapest premise check.

---

## Context: what we are and are not measuring

We are **only** comparing apples-to-apples HTTP throughput at full keep-alive on the same Mac, same Bun version, same React version, same `HelloWorld` component. The two scenarios differ in exactly one axis: the HTTP layer and IPC.

- **Brust SSR:** Rust accept loop → flume → TCP worker → napi tsfn → Bun Worker → React `renderToString` → SAB → Rust → wire.
- **Bun.serve baseline:** Bun.serve fetch handler → React `renderToString` on the main isolate → wire.

We are **not** measuring:

- Cold start, startup time, memory footprint, GC pauses.
- p999 / tail latencies under sustained load. `oha` reports p50/p95/p99 within a 10 s window — that is "throughput-shaped" data, not tail-shaped.
- Loader I/O, DB latency, cache hits — there is no DB and no cache in either scenario.
- Pretend axum numbers — `architecture.md` cites "100k+ axum baseline" anecdotally; we do not stand up axum here.

If the harness landed and Brust **loses** to Bun.serve, the framework's whole premise is questionable. That is intentional: the cheap check.

### Where things land

| File | Status |
|---|---|
| `scripts/benchmark.ts` | Create. ~200 lines. Single entry point. |
| `bench/RESULTS.md` | Create on first run. Overwritten each run. |
| `bench/RESULTS.json` | Create on first run. Overwritten each run. |
| `bench/.gitignore` | Create. Contents: just `RESULTS.json`. |
| `package.json` | Modify. Add `"bench": "bun run scripts/benchmark.ts"`. |
| `tests/integration.test.ts` | Not touched. The bench is invoked manually, not by `bun run test`. |
| `runtime/index.ts`, `src/**`, `example/**` | Not touched. We treat the servers as black boxes. |

---

### Task 1: Baseline verification

**Files:** none modified

- [ ] **Step 1: Confirm cargo build is clean and napi `.node` is current**

Run: `cargo build && cd runtime && bun run build:debug && cd -`
Expected: cargo finishes, `runtime/index.darwin-arm64.node` regenerated. No errors. The bench script needs a working Brust to drive; if the build is broken, fix that first.

- [ ] **Step 2: Confirm `oha` is on PATH**

Run: `oha --version`
Expected: a line like `oha 1.x.x` (or `0.x` — any version >= 0.6 supports `--json`). If you see `command not found`, install it with one of:

```bash
brew install oha
# or
cargo install oha
```

If neither install path is available, stop and ask the user how they want to provide `oha`. Do not attempt to vendor it.

- [ ] **Step 3: Confirm both servers boot independently**

Run:

```bash
bun run example/hello-world/index.ts &
BRUST_PID=$!
sleep 1
curl -sf http://127.0.0.1:3000/ping > /dev/null && echo "Brust OK"
curl -sf http://127.0.0.1:3000/      > /dev/null && echo "Brust SSR OK"
kill -INT $BRUST_PID
wait $BRUST_PID 2>/dev/null

bun run example/bun-serve-baseline/index.ts &
BS_PID=$!
sleep 1
curl -sf http://127.0.0.1:3001/ping > /dev/null && echo "Bun.serve OK"
curl -sf http://127.0.0.1:3001/      > /dev/null && echo "Bun.serve SSR OK"
kill -INT $BS_PID
wait $BS_PID 2>/dev/null
```

Expected: four `OK` lines printed in order. If any fail, debug the corresponding server before continuing — the bench script assumes both work.

- [ ] **Step 4: Skip commit**

This task only verifies starting state.

---

### Task 2: Bootstrap directory layout and gitignore

**Files:**
- Create: `bench/.gitignore`

- [ ] **Step 1: Create `bench/` and its `.gitignore`**

Run:

```bash
mkdir -p bench
```

Then create `bench/.gitignore` with these exact contents:

```
RESULTS.json
```

(We keep `RESULTS.md` in git so anyone can see the latest numbers without rerunning. The raw JSON is regeneratable noise.)

- [ ] **Step 2: Skip commit**

Folder + gitignore land together with the driver in Task 6.

---

### Task 3: Write the failing harness skeleton

**Files:**
- Create: `scripts/benchmark.ts`

TDD-ish — we land the skeleton that *almost* works first (it errors at the `oha` call), then fill in the implementation. Each downstream task replaces a `throw new Error('NOT_IMPLEMENTED: …')` with real code.

- [ ] **Step 1: Create `scripts/benchmark.ts` with the skeleton**

Create `scripts/benchmark.ts` with:

```typescript
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
// Requires `oha` on PATH.

import { spawn } from 'bun'
import { mkdir, writeFile } from 'node:fs/promises'

type Scenario = {
  id: string                       // short id used in column headers, e.g. 'brust'
  label: string                    // pretty label used in the markdown table
  cmd: string[]                    // argv to start the server
  env?: Record<string, string>     // extra env vars
  expectedPortLog: RegExp          // regex with one capture group → port number
}

type Probe = {
  path: string                     // request path, e.g. '/' or '/ping'
}

type Result = {
  scenarioId: string
  scenarioLabel: string
  path: string
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
const WARMUP_MS = 1000

const SCENARIOS: Scenario[] = [
  {
    id: 'brust',
    label: 'Brust (Rust HTTP + napi + SAB)',
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { BRUST_PORT: '38201' },
    expectedPortLog: /listening on 127\.0\.0\.1:(\d+)/,
  },
  {
    id: 'bun-serve',
    label: 'Bun.serve + React renderToString',
    cmd: ['bun', 'run', 'example/bun-serve-baseline/index.ts'],
    env: { BUN_BASELINE_PORT: '38202' },
    expectedPortLog: /listening on http:\/\/[^:]+:(\d+)/,
  },
]

const PROBES: Probe[] = [
  { path: '/ping' },
  { path: '/' },
]

async function runScenario(s: Scenario, p: Probe): Promise<Result> {
  throw new Error('NOT_IMPLEMENTED: runScenario — see Task 4')
}

function renderMarkdown(results: Result[]): string {
  throw new Error('NOT_IMPLEMENTED: renderMarkdown — see Task 5')
}

async function main() {
  const results: Result[] = []
  for (const s of SCENARIOS) {
    for (const p of PROBES) {
      console.log(`\n→ ${s.label}   ${p.path}   conn=${CONN}  dur=${DURATION}`)
      const r = await runScenario(s, p)
      results.push(r)
      console.log(
        `  rps=${r.rps.toFixed(0).padStart(7)}   ` +
        `p50=${(r.p50ms ?? NaN).toFixed(2)}ms   ` +
        `p99=${(r.p99ms ?? NaN).toFixed(2)}ms   ` +
        `errors=${r.errors}`
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
```

- [ ] **Step 2: Confirm it imports cleanly**

Run: `bun run --silent scripts/benchmark.ts 2>&1 | head -5`
Expected: it prints the first `→ Brust …` log line and then throws `NOT_IMPLEMENTED: runScenario`. That's the desired failure mode — types resolved, two helper functions are pending. If you see a type error or `Cannot find module 'bun'`, ensure the project's `tsconfig.json` is healthy.

- [ ] **Step 3: Skip commit**

We commit the skeleton + Task 4 + Task 5 together at Task 6 to keep history tidy. (Two separate commits if you prefer — see Task 6 for the choice.)

---

### Task 4: Implement `runScenario`

**Files:**
- Modify: `scripts/benchmark.ts`

Replace the `NOT_IMPLEMENTED` stub for `runScenario` with the actual scenario driver.

- [ ] **Step 1: Replace the `runScenario` body**

Find the existing `runScenario` declaration in `scripts/benchmark.ts` (a single-line `throw`). Replace the whole function with:

```typescript
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

  // Warm-up window — let the worker pool finish boot, JIT settle, etc.
  await new Promise((r) => setTimeout(r, WARMUP_MS))

  const url = `http://127.0.0.1:${port}${p.path}`
  let ohaJson: any
  try {
    ohaJson = await runOha(url, CONN, DURATION)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }

  // oha JSON shape (v1.x):
  //   summary.requestsPerSec      number
  //   summary.totalRequests       number  (newer versions)
  //   summary.errors              number  (newer versions; alias to summary.total - successCount)
  //   latencyPercentiles.p50      seconds (yes, seconds — oha uses fractional seconds)
  //   latencyPercentiles.p95      seconds
  //   latencyPercentiles.p99      seconds
  //
  // Older oha emits slightly different field names (`requestPerSec` without the
  // trailing s). We defensively read both.
  const summary  = ohaJson.summary ?? {}
  const percent  = ohaJson.latencyPercentiles ?? {}
  const rps      = numberOf(summary.requestsPerSec, summary.requestPerSec) ?? 0
  const totalReq = numberOf(summary.totalRequests, summary.totalRequest) ?? 0
  const errors   = numberOf(summary.errors, ohaJson.errorDistribution?.total) ?? 0
  const p50      = secondsToMs(percent.p50)
  const p95      = secondsToMs(percent.p95)
  const p99      = secondsToMs(percent.p99)

  return {
    scenarioId: s.id,
    scenarioLabel: s.label,
    path: p.path,
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

async function runOha(url: string, conn: number, duration: string): Promise<any> {
  const oha = spawn({
    cmd: ['oha', '-c', String(conn), '-z', duration, '--no-tui', '--json', '-m', 'GET', url],
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
```

These helpers (`readPort`, `runOha`, `numberOf`, `secondsToMs`) belong below `runScenario` in the same file; do not export them.

- [ ] **Step 2: Verify just the Brust + `/ping` scenario runs**

Temporarily shorten the run by commenting out the second `SCENARIOS` entry and the `/` probe. Edit the constants in `scripts/benchmark.ts`:

```typescript
const PROBES: Probe[] = [
  { path: '/ping' },
  // { path: '/' },
]
```

```typescript
const SCENARIOS: Scenario[] = [
  {
    id: 'brust',
    label: 'Brust (Rust HTTP + napi + SAB)',
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { BRUST_PORT: '38201' },
    expectedPortLog: /listening on 127\.0\.0\.1:(\d+)/,
  },
  // {
  //   id: 'bun-serve',
  //   label: 'Bun.serve + React renderToString',
  //   cmd: ['bun', 'run', 'example/bun-serve-baseline/index.ts'],
  //   env: { BUN_BASELINE_PORT: '38202' },
  //   expectedPortLog: /listening on http:\/\/[^:]+:(\d+)/,
  // },
]
```

Run: `BENCH_DUR=3s bun run scripts/benchmark.ts`

Expected (numbers will vary by machine):

```
→ Brust (Rust HTTP + napi + SAB)   /ping   conn=120  dur=3s
  rps= 1xxxxx   p50=0.xxms   p99=x.xxms   errors=0

Wrote bench/RESULTS.md and bench/RESULTS.json
```

`renderMarkdown` will throw `NOT_IMPLEMENTED` *before* the write happens — but only after `runScenario` completes once. So you should see the `→ Brust …` line, the `rps=… ` summary line, then the `NOT_IMPLEMENTED: renderMarkdown — see Task 5` error. That is the correct state.

If you see `oha exited` with a non-zero code, run `oha -c 120 -z 3s --no-tui --json http://127.0.0.1:3000/ping` against a manually started Brust to isolate whether the issue is the harness or `oha` itself.

- [ ] **Step 3: Revert the comments before continuing**

Uncomment the second scenario and the `/` probe. Restore both arrays to the full versions from Step 1.

- [ ] **Step 4: Skip commit**

Wait until Task 6.

---

### Task 5: Implement `renderMarkdown`

**Files:**
- Modify: `scripts/benchmark.ts`

Replace the `NOT_IMPLEMENTED` stub for `renderMarkdown` with the real markdown writer.

- [ ] **Step 1: Replace the function**

Find the `renderMarkdown` stub. Replace it with:

```typescript
function renderMarkdown(results: Result[]): string {
  const date = new Date().toISOString().slice(0, 10)
  const hardware = `${process.platform}/${process.arch}`
  const node = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : 'Bun ?'
  const lines: string[] = []
  lines.push(`# Brust benchmarks — ${date}`)
  lines.push('')
  lines.push(`**Conditions:** \`oha -c ${CONN} -z ${DURATION} --no-tui --json\``)
  lines.push(`· runtime: ${node}`)
  lines.push(`· host: ${hardware}`)
  lines.push(`· warmup: ${WARMUP_MS} ms`)
  lines.push('')
  lines.push('| Scenario | Path | RPS | p50 (ms) | p95 (ms) | p99 (ms) | Total | Errors |')
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|')
  for (const r of results) {
    const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(2))
    lines.push(
      `| ${r.scenarioLabel} | \`${r.path}\` | ${Math.round(r.rps).toLocaleString()} | ` +
      `${fmt(r.p50ms)} | ${fmt(r.p95ms)} | ${fmt(r.p99ms)} | ` +
      `${r.totalRequests.toLocaleString()} | ${r.errors} |`,
    )
  }
  lines.push('')
  lines.push('Generated by `bun run bench` — see `scripts/benchmark.ts`.')
  return lines.join('\n') + '\n'
}
```

- [ ] **Step 2: Run the full benchmark end-to-end**

Run: `BENCH_DUR=3s bun run scripts/benchmark.ts`

Expected (numbers will vary):

```
→ Brust (Rust HTTP + napi + SAB)   /ping   conn=120  dur=3s
  rps= 1xxxxx   p50=...   p99=...   errors=0

→ Brust (Rust HTTP + napi + SAB)   /       conn=120  dur=3s
  rps=  7xxxx   p50=...   p99=...   errors=0

→ Bun.serve + React renderToString   /ping   conn=120  dur=3s
  rps=   xxxx   p50=...   p99=...   errors=0

→ Bun.serve + React renderToString   /       conn=120  dur=3s
  rps=   xxxx   p50=...   p99=...   errors=0

Wrote bench/RESULTS.md and bench/RESULTS.json
```

- [ ] **Step 3: Inspect the generated files**

Run: `cat bench/RESULTS.md`
Expected: a header, the conditions block, and a 4-row table with all four scenario/probe pairs filled in. No `—` placeholders in the RPS column. p50/p95/p99 values are positive numbers.

Run: `head -c 400 bench/RESULTS.json`
Expected: a JSON array opening with `"scenarioId": "brust"` and so on.

If either file is missing or empty, the script silently swallowed an exception — check the console for `Wrote bench/RESULTS.md and bench/RESULTS.json`; that string is the only success signal.

- [ ] **Step 4: Skip commit**

Wait until Task 6 — we land everything together.

---

### Task 6: Wire the `bench` script and commit

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the `bench` npm script**

Open `package.json`. Locate the `"scripts"` block (currently lines 27-31):

```json
  "scripts": {
    "build":       "cd runtime && bun run build",
    "build:debug": "cd runtime && bun run build:debug",
    "test":        "bun test tests/integration.test.ts",
    "dev":         "bun run example/hello-world/index.ts",
    "dev:baseline": "bun run example/bun-serve-baseline/index.ts"
  }
```

Add a `"bench"` entry. The full block becomes:

```json
  "scripts": {
    "build":        "cd runtime && bun run build",
    "build:debug":  "cd runtime && bun run build:debug",
    "test":         "bun test tests/integration.test.ts",
    "dev":          "bun run example/hello-world/index.ts",
    "dev:baseline": "bun run example/bun-serve-baseline/index.ts",
    "bench":        "bun run scripts/benchmark.ts"
  }
```

(Indent the values to a consistent column to match the existing style. JSON does not care, the diff does.)

- [ ] **Step 2: Run the full bench once more with the real 10 s duration**

Run: `bun run bench`

Expected: same output shape as Task 5 Step 2, but with the default 10 s window. Total wall time ≈ 2 × 2 servers × 2 probes × 10 s + boot overhead ≈ 50 s. If wall time is meaningfully shorter, somebody is `BENCH_DUR`-overridden or a probe was skipped.

- [ ] **Step 3: Verify `bench/RESULTS.md` looks right**

Run: `cat bench/RESULTS.md`
Expected: 4 rows. Sanity targets, based on the M1 Pro numbers in `architecture.md`:
- Brust `/ping` ≈ 100k–110k rps.
- Brust `/` ≈ 60k–75k rps.
- Bun.serve `/ping` and `/` are the unknowns we're measuring. **Whatever value comes out is the data.** Do not adjust the script to make Brust look better.

If Brust's `/` row reports `rps < 30000` on an M1 Pro / 16 GB / quiet machine, something is off (workers misconfigured? `BRUST_WORKERS` env leaked from the shell? builds in debug instead of release for cargo?). Stop and inspect rather than commit a misleading number.

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark.ts bench/.gitignore bench/RESULTS.md package.json
git commit -m "$(cat <<'EOF'
feat(bench): reproducible Brust vs Bun.serve benchmark harness

Add scripts/benchmark.ts that boots each candidate server, runs oha
against /ping and /, parses the JSON, and writes a markdown summary
to bench/RESULTS.md plus raw JSON to bench/RESULTS.json (gitignored).
Single command via `bun run bench`.

First runs measured on M1 Pro / Bun 1.3 / release Brust build are
captured in bench/RESULTS.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

`bench/RESULTS.json` is excluded by `bench/.gitignore` and should not appear in `git status` after the commit. If it does, the gitignore is in the wrong directory — ensure it lives at `bench/.gitignore`, not the repo root.

---

### Task 7: Document the harness in the architecture doc and previous results table

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Locate the Performance section**

Open `architecture.md`. Find the `## Performance` heading (around line 854). The current table ends with the row `| /, /ping (Bun.serve baseline) | — | *TBD* | — |`.

- [ ] **Step 2: Replace the `*TBD*` row with the measured numbers**

Read `bench/RESULTS.md` from Task 6 Step 3. The Bun.serve `/ping` and Bun.serve `/` rows are what we want. Replace the single `*TBD*` row with two rows reflecting actual measurements. For example, if Bun.serve `/ping` measured 58k rps and `/` measured 14k rps, the new lines become:

```markdown
| `/ping` (Bun.serve baseline) | — | 58 k | — |
| `/` (Bun.serve baseline) | — | 14 k | — |
```

Use the actual numbers from your run, rounded to the nearest 1k. Drop the p99 column for the baseline rows (it stays `—`) because `oha`'s p99 inside a 10 s window on Bun's main isolate is noisy; we only quote it for the Rust accept loop.

Also append a one-line pointer right under the table:

```markdown
Reproduce with `bun run bench` — driver at `scripts/benchmark.ts`, results at `bench/RESULTS.md`.
```

(There is already a similar pointer line for the baseline comparator; replace it with this combined line if convenient, or keep both — both are accurate after this plan lands.)

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): fill in Bun.serve baseline numbers from bench

Replace TBD with the values produced by the new benchmark harness.
Point readers at `bun run bench` for reproduction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run after implementation, before declaring done)

- [ ] `bun run bench` finishes without errors in roughly 45–55 s on an M1 Pro.
- [ ] `bench/RESULTS.md` exists, has a 4-row table, and is checked into git.
- [ ] `bench/RESULTS.json` exists locally but is **not** in `git status` (gitignored).
- [ ] `git log --oneline -2` shows the two new commits: `feat(bench): …` and `docs(architecture): fill in Bun.serve baseline …`.
- [ ] `package.json` has the `"bench"` script and `bun run bench` invokes `scripts/benchmark.ts`.
- [ ] `architecture.md` no longer contains `*TBD*` in the Performance table.
- [ ] No source files under `src/`, `runtime/`, `example/`, or `tests/` were modified by this plan. `git diff HEAD~2 -- src/ runtime/ example/ tests/` is empty.
- [ ] Re-running `bun run bench` is idempotent: it overwrites both files cleanly, no append-style growth in `RESULTS.md`.

## Risks and caveats

1. **`oha` JSON schema variance across versions.** The defensive `numberOf(summary.requestsPerSec, summary.requestPerSec)` pattern in `runOha` covers the two known field names. If a future `oha` renames again, the table will show `0` for RPS — easy to spot, but worth knowing.
2. **Port collisions.** `BRUST_PORT=38201` and `BUN_BASELINE_PORT=38202` are hard-coded. If something is listening on those ports already, the server boot will fail mid-run. The script kills its own children on failure, but it does not free other people's ports. Pick ports above 38000 to minimize the chance.
3. **Background noise.** Anything CPU-hot on the same machine (compile, video call, Slack notification storm) skews `oha`. The script doesn't try to detect that. Re-run if numbers look wildly different from the architecture doc's reference values.
4. **`renderToString` is not the same on Bun.serve and Brust** in *one* subtle way: Brust runs each call in a Bun Worker (isolated V8), Bun.serve runs them on the main isolate. The render output is identical. Throughput differs because Brust has N parallel workers vs Bun.serve's 1 isolate. This is the comparison; it is not a confounder.

## Out of scope

- Comparing against Next.js, Astro, or Remix. Those would need scaffolded apps; non-trivial to set up correctly without favoring any particular one.
- Memory or CPU profiling during the bench. `oha` is throughput-only.
- A CI-friendly variant that fails the build on perf regression. The signal-to-noise of micro-benches in CI is poor; revisit when there's a reason (e.g., a perf-sensitive PR that needs gating).
- Comparing per-route latencies — `/` and `/ping` are the only routes today. Once Routing (Tier 1) lands, expand `PROBES`.
- Visualization. Markdown table is sufficient at this scale.
