/**
 * A1 — interleave-win microbench (decision gate for Phase B of
 * docs/superpowers/specs/2026-06-05-ssr-multirender-zerocopy-design.md).
 *
 * Question: does running N React SSR renders CONCURRENTLY in one Bun isolate
 * beat running them SERIALLY? Physics says it helps only when renders YIELD
 * (Suspense / async data) — never for pure-CPU renders (JSC event loop is
 * cooperative single-thread). This measures the actual ratio across a sweep of
 * the I/O:CPU mix so we know whether the (invasive) K-slot machine is worth it.
 *
 *   bun run bench/micro/interleave.ts
 *
 * Prints serial vs concurrent wall-clock per (N, DATA_MS, CPU_MS) cell + a
 * verdict. DO NOT commit the printed numbers (standing constraint) — only this
 * harness is committed.
 */
import { renderToReadableStream } from 'react-dom/server'
import { Suspense, createElement as h } from 'react'

// ---- workload knobs --------------------------------------------------------

/** Busy-spin `ms` of synchronous CPU inside a component body. This is the part
 *  that genuinely serializes within one isolate (blocks the event loop). */
function burnCpu(ms: number): void {
  if (ms <= 0) return
  const end = performance.now() + ms
  // Spin. A tight loop is the honest model of CPU-bound render work.
  while (performance.now() < end) {
    /* spin */
  }
}

function CpuWork({ ms }: { ms: number }) {
  burnCpu(ms)
  return h('div', null, 'cpu')
}

/** A fresh suspender per render: throws a timer-backed promise on first read,
 *  resolves after `ms`. Models a Suspense boundary awaiting async data — the
 *  ONLY thing that lets the event loop interleave another render. */
function makeSuspender(ms: number) {
  let status: 'pending' | 'done' = 'pending'
  let promise: Promise<void> | null = null
  return function Suspender() {
    if (status === 'pending') {
      if (!promise) {
        promise = new Promise<void>((resolve) => {
          setTimeout(() => {
            status = 'done'
            resolve()
          }, ms)
        })
      }
      throw promise
    }
    return h('div', null, 'data')
  }
}

/** Build one independent render tree. Half the CPU cost runs synchronously in
 *  the shell; the other half runs *after* the Suspense data resolves — so a
 *  concurrent peer can use the isolate during the data wait. */
function makeTree(dataMs: number, cpuMs: number) {
  const Suspender = makeSuspender(dataMs)
  return h(
    'html',
    null,
    h(
      'body',
      null,
      h(CpuWork, { ms: cpuMs / 2 }),
      h(
        Suspense,
        { fallback: h('div', null, 'loading') },
        h(Suspender, null),
        h(CpuWork, { ms: cpuMs / 2 }),
      ),
    ),
  )
}

// ---- driver ----------------------------------------------------------------

async function drainFully(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  for (let done = false; !done; ) {
    done = (await reader.read()).done
  }
}

async function renderOne(dataMs: number, cpuMs: number): Promise<void> {
  const stream = await renderToReadableStream(makeTree(dataMs, cpuMs), {
    onError() {
      /* suppress — measurement only */
    },
  })
  await drainFully(stream)
}

async function timeSerial(n: number, dataMs: number, cpuMs: number): Promise<number> {
  const t0 = performance.now()
  for (let i = 0; i < n; i++) await renderOne(dataMs, cpuMs)
  return performance.now() - t0
}

async function timeConcurrent(n: number, dataMs: number, cpuMs: number): Promise<number> {
  const t0 = performance.now()
  const jobs: Promise<void>[] = []
  for (let i = 0; i < n; i++) jobs.push(renderOne(dataMs, cpuMs))
  await Promise.all(jobs)
  return performance.now() - t0
}

async function median(fn: () => Promise<number>, reps: number): Promise<number> {
  const xs: number[] = []
  for (let i = 0; i < reps; i++) xs.push(await fn())
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)] ?? 0
}

// I/O:CPU mixes. DATA_MS = Suspense data wait; CPU_MS = synchronous render cost.
const CELLS: Array<{ label: string; dataMs: number; cpuMs: number }> = [
  { label: 'pure-cpu      (data=0,  cpu=20)', dataMs: 0, cpuMs: 20 },
  { label: 'cpu-heavy     (data=5,  cpu=20)', dataMs: 5, cpuMs: 20 },
  { label: 'balanced      (data=20, cpu=10)', dataMs: 20, cpuMs: 10 },
  { label: 'io-heavy      (data=40, cpu=4 )', dataMs: 40, cpuMs: 4 },
  { label: 'io-bound      (data=40, cpu=0 )', dataMs: 40, cpuMs: 0 },
]
const NS = [2, 4, 8]
const REPS = 5
const WARMUP = 2

async function main() {
  // Warm up the isolate / JIT so the first cell isn't penalized.
  for (let i = 0; i < WARMUP; i++) await renderOne(10, 10)

  console.log('A1 interleave-win microbench — Bun', Bun.version)
  console.log('ratio = concurrent / serial wall-clock. <1 = concurrency wins.\n')
  console.log(
    [
      'cell'.padEnd(34),
      'N',
      'serial(ms)'.padStart(11),
      'concur(ms)'.padStart(11),
      'ratio'.padStart(7),
    ].join('  '),
  )
  console.log('-'.repeat(80))

  let bestIoRatio = 1
  let worstCpuRatio = 0
  for (const cell of CELLS) {
    for (const n of NS) {
      const serial = await median(() => timeSerial(n, cell.dataMs, cell.cpuMs), REPS)
      const concur = await median(() => timeConcurrent(n, cell.dataMs, cell.cpuMs), REPS)
      const ratio = concur / serial
      if (cell.dataMs === 0) worstCpuRatio = Math.max(worstCpuRatio, ratio)
      if (cell.label.startsWith('io-bound')) bestIoRatio = Math.min(bestIoRatio, ratio)
      console.log(
        [
          cell.label.padEnd(34),
          String(n),
          serial.toFixed(1).padStart(11),
          concur.toFixed(1).padStart(11),
          ratio.toFixed(3).padStart(7),
        ].join('  '),
      )
    }
    console.log('-'.repeat(80))
  }

  console.log('\nVERDICT')
  console.log(`  best io-bound ratio:   ${bestIoRatio.toFixed(3)}  (lower = bigger interleave win)`)
  console.log(
    `  worst pure-cpu ratio:  ${worstCpuRatio.toFixed(3)}  (>1 = concurrency tax on sync pages)`,
  )
  if (bestIoRatio < 0.85) {
    console.log(
      '  → Phase B JUSTIFIED: concurrent renders meaningfully beat serial on Suspense pages.',
    )
  } else {
    console.log('  → Phase B NOT worth its cost: no meaningful interleave win. STOP, document.')
  }
  if (worstCpuRatio > 1.1) {
    console.log('  → Concurrency taxes pure-CPU pages >10%: K=1 default + opt-in is mandatory.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
