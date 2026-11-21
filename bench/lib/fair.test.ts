// F595: the fair bench's pure parts, no load: the core split, the interleaved order, medians and marks, the sweep's
// best N, the "not compressed" cell, Next's runtime choice without node, the /proc readers.
import { afterEach, expect, test } from 'bun:test'
import { nextRuntime } from './apps'
import { cpuSecondsOf } from './oha'
import { parseStat } from './cpu'
import { aggregate, bodyNote, type CellRun, type FairResults, legacyResults, renderRun, sweepTable, verdicts } from './fair'
import { evaluateGuards } from './guard'
import type { OhaNums } from './oha'
import { balanceRatio, bestN, defaultSweep, generatorLimited, generatorShare, interleave, median, noisy, spreadOf, unbalanced } from './stats'
import { cpuList, parseLscpu, splitCores } from './topology'

const LSCPU_SMT = `# The following is the parsable format
# CPU,Core,Socket
0,0,0
1,0,0
2,1,0
3,1,0
4,2,0
5,2,0
6,3,0
7,3,0
8,4,0
9,4,0
10,5,0
11,5,0
`

test('topology: SMT siblings stay on one side; the generator gets the last physical cores', () => {
  const cores = parseLscpu(LSCPU_SMT)
  expect(cores).toHaveLength(6)
  expect(cores[0]).toEqual({ id: '0:0', cpus: [0, 1] })
  const s = splitCores(cores, 2)
  expect(s).toEqual({ server: [0, 1, 2, 3, 4, 5, 6, 7], gen: [8, 9, 10, 11], serverCores: 4, genCores: 2 })
  for (const c of cores) expect(c.cpus.every((x) => s.server.includes(x)) || c.cpus.every((x) => s.gen.includes(x))).toBe(true)
  expect(cpuList(s.server)).toBe('0-7')
  expect(cpuList([0, 2, 3, 4, 9])).toBe('0,2-4,9')
})

test('topology: siblings listed apart (0 and 6 on one core), odd counts, two sockets, and a host too small to split', () => {
  const apart = parseLscpu('0,0,0\n1,1,0\n2,2,0\n3,0,0\n4,1,0\n5,2,0\n')
  expect(apart.map((c) => c.cpus)).toEqual([[0, 3], [1, 4], [2, 5]])
  expect(splitCores(apart, 1)).toMatchObject({ server: [0, 1, 3, 4], gen: [2, 5] })
  const odd = parseLscpu('0,0,0\n1,1,0\n2,2,0\n')
  expect(splitCores(odd, 2)).toMatchObject({ server: [0], gen: [1, 2], serverCores: 1, genCores: 2 })
  const sockets = parseLscpu('0,0,0\n1,0,1\n')
  expect(sockets).toHaveLength(2)
  expect(() => splitCores(parseLscpu('0,0,0\n1,0,0\n'), 1)).toThrow(/cannot pin: 1 physical core/)
  expect(() => splitCores(parseLscpu(LSCPU_SMT), 0)).toThrow(/at least 1 physical core/)
  expect(() => parseLscpu('x,,\n')).toThrow(/cannot read/)
})

test('interleave: every round is a permutation of the cells, the order follows the seed', () => {
  const cells = ['a', 'b', 'c', 'd', 'e']
  const one = interleave(cells, 3, 42)
  expect(one).toHaveLength(15)
  for (let r = 0; r < 3; r++) expect(one.filter((x) => x.round === r).map((x) => x.cell).sort()).toEqual(cells)
  expect(interleave(cells, 3, 42)).toEqual(one)
  expect(interleave(cells, 3, 43)).not.toEqual(one)
  expect(one.slice(0, 5).map((x) => x.cell)).not.toEqual(one.slice(5, 10).map((x) => x.cell))
})

test('median, spread, noisy; generator share and its mark; balance and its mark', () => {
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 2, 3])).toBe(2.5)
  expect(() => median([])).toThrow()
  const s = spreadOf([100, 104, 102])
  expect(s).toEqual({ median: 102, min: 100, max: 104, spread: 4 / 102 })
  expect(noisy(s)).toBe(false)
  expect(noisy(spreadOf([100, 110, 104]))).toBe(true)
  expect(generatorShare(36, 10, 4)).toBeCloseTo(0.9)
  expect(generatorLimited(0.9)).toBe(true)
  expect(generatorLimited(0.89)).toBe(false)
  expect(generatorShare(1, 0, 4)).toBe(0)
  // review F1: the share divides by oha's -z window, not the process wall time (3.15 s for a 3 s run)
  expect(generatorShare(5.36, 3, 4)).toBeCloseTo(0.4467, 3)
  expect(cpuSecondsOf({ user: 886593n, system: 123710n })).toBeCloseTo(1.010303, 6)
  expect(cpuSecondsOf({ user: 2_000_000, system: 500_000 })).toBe(2.5)
  expect(cpuSecondsOf(undefined)).toBeNull()
  expect(balanceRatio([2, 4])).toBe(2)
  expect(unbalanced(2)).toBe(false)
  expect(unbalanced(2.01)).toBe(true)
  expect(balanceRatio([1])).toBe(1)
  expect(balanceRatio([0, 3])).toBe(Number.POSITIVE_INFINITY)
})

test('best N: the highest median rps whose p99 is within 20% of the best p99', () => {
  expect(bestN([])).toBeNull()
  const pts = [
    { n: 1, rps: 100, p99: 1.0 },
    { n: 2, rps: 190, p99: 1.1 },
    { n: 4, rps: 300, p99: 1.19 },
    { n: 8, rps: 320, p99: 2.0 },
  ]
  expect(bestN(pts)?.n).toBe(4)
  expect(bestN([{ n: 2, rps: 10, p99: 1 }, { n: 1, rps: 10, p99: 1 }])?.n).toBe(1)
  expect(defaultSweep(8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(defaultSweep(2)).toEqual([1, 2])
  const big = defaultSweep(32)
  expect(big.length).toBeLessThanOrEqual(8)
  expect(big.slice(0, 3)).toEqual([1, 2, 3])
  expect(big.at(-1)).toBe(32)
})

const nums = (rps: number, p99 = 1, bytes = 1000): OhaNums => ({ rps, p50: p99 / 2, p95: p99 * 0.9, p99, total: rps * 10, errors: 0, status: { '200': rps * 10 }, bytes })
const run = (rps: number, o: Partial<CellRun> = {}): CellRun => ({ round: 0, nums: nums(rps), gen: 0.5, procCpu: [], ...o })

test('a cell: median and [min-max], and every mark from its runs', () => {
  const quiet = aggregate({ app: 'brust', probe: 'D', enc: 'identity', conn: 120, n: 8 }, [run(100), run(102), run(101)], true)
  expect(quiet.rps).toMatchObject({ median: 101, min: 100, max: 102 })
  expect(quiet.marks).toEqual([])
  const marked = aggregate({ app: 'bun-serve', probe: 'D', enc: 'gzip', conn: 120, n: 8 }, [run(100, { gen: 0.95, procCpu: [1, 3] }), run(120)], false)
  expect(marked.marks).toEqual(['noisy', 'generator-limited', 'unbalanced', 'not compressed'])
  expect(marked.balance).toBe(3)
  // c=8 on 8 copies: not "unbalanced" (the port hash), but named: fewer copies did the work
  const low = aggregate({ app: 'next', probe: 'D', enc: 'identity', conn: 8, n: 8 }, [run(100, { procCpu: [9, 0, 1, 1, 1, 1, 1, 1] })], null)
  expect(low.balance).toBe(Number.POSITIVE_INFINITY)
  expect(low.marks).toEqual(['copies idle'])
  // even copies at low c: no mark
  expect(aggregate({ app: 'next', probe: 'D', enc: 'identity', conn: 8, n: 2 }, [run(100, { procCpu: [1, 1.5] })], null).marks).toEqual([])
  // identity is never "not compressed"; an unmeasured compression is not a mark
  expect(aggregate({ app: 'next', probe: 'D', enc: 'identity', conn: 120, n: 8 }, [run(1)], false).marks).toEqual([])
  expect(aggregate({ app: 'next', probe: 'D', enc: 'gzip', conn: 120, n: 8 }, [run(1)], null).marks).toEqual([])
  expect(() => aggregate({ app: 'next', probe: 'D', enc: 'gzip', conn: 120, n: 8 }, [], null)).toThrow()
})

const fixture = (kind: 'run' | 'sweep'): FairResults => ({
  header: {
    kind, date: '2026-11-21', machine: { model: 'm', chip: 'c', memGb: 16 }, os: 'linux/x64', cores: 12, serverCpus: [0, 1, 2, 3], genCpus: [4, 5], versions: { bun: '1.4.5' }, sha: 'abc', seed: 1, rounds: 3, dur: '6s', warmup: '2s', conns: kind === 'run' ? [120, 16] : [120],
    budgets: { brust: 'workers 4 (one process)' }, defaults: { brustWorkers: 4, tokioThreads: 4 }, estimateMin: 1, tookMin: 1, skipped: [],
  },
  work: [
    { app: 'brust', probe: 'S-render', work: 'renders per request, hydration scripts', compressed: true, bytes: 1295 },
    { app: 'brust', probe: 'I', work: 'renders per request, hydration scripts', compressed: true, bytes: 1295 },
    { app: 'bun-serve', probe: 'I', work: 'renders per request, no scripts', compressed: false, bytes: 459 },
  ],
  cells:
    kind === 'run'
      ? [
          aggregate({ app: 'brust', probe: 'S-render', enc: 'identity', conn: 120, n: 4 }, [run(200)], true),
          aggregate({ app: 'bun-serve', probe: 'S-render', enc: 'identity', conn: 120, n: 4 }, [run(100, { gen: 0.95 })], false),
          aggregate({ app: 'bun-serve', probe: 'S-render', enc: 'gzip', conn: 120, n: 4 }, [run(100)], false),
          aggregate({ app: 'brust', probe: 'S', enc: 'identity', conn: 120, n: 4 }, [run(500)], true),
          aggregate({ app: 'bun-serve', probe: 'S', enc: 'identity', conn: 120, n: 4 }, [run(150)], false),
          aggregate({ app: 'brust', probe: 'A1', enc: 'identity', conn: 1, n: 4 }, [run(20)], null),
        ]
      : [1, 2, 4].flatMap((n) => [aggregate({ app: 'brust', probe: 'D', enc: 'identity', conn: 120, n }, [{ round: 0, nums: nums(n * 100, n === 4 ? 3 : 1), gen: 0.3, procCpu: [] }], true)]),
})

test('like with like: S only between cached pages, S-render and D between renderers; marks travel with the ratio', () => {
  const v = verdicts(fixture('run'))
  expect(v.some((l) => l.includes(' S ') && l.includes('bun-serve'))).toBe(false)
  const sr = v.find((l) => l.includes('S-render'))!
  expect(sr).toContain('brust / bun-serve = 2.00')
  expect(sr).toContain('bun-serve generator-limited')
  expect(bodyNote(fixture('run').work, 'I')).toContain('bodies differ by more than 10%')
  expect(bodyNote([{ app: 'brust', probe: 'D', work: '', compressed: true, bytes: 100 }, { app: 'next', probe: 'D', work: '', compressed: true, bytes: 105 }], 'D')).toBeNull()
})

test('the markdown names the pinning, the work and the marks; the sweep names the best N and brust default', () => {
  const md = renderRun(fixture('run'))
  expect(md).toContain('server CPUs 0,1,2,3 · generator CPUs 4,5')
  expect(md).toContain('work: brust renders per request, hydration scripts')
  expect(md).toContain('not compressed')
  expect(md).toContain('load minutes planned 1, taken 1')
  expect(md).toContain('## Marked cells')
  expect(md).not.toMatch(/macOS/)
  const unpinned = renderRun({ ...fixture('run'), header: { ...fixture('run').header, serverCpus: null, genCpus: null } })
  expect(unpinned).toContain('unpinned: ratios only')
  const sweep = fixture('sweep')
  expect(sweepTable(sweep)[0]).toMatchObject({ app: 'brust', probe: 'D', best: { n: 2 } })
  expect(renderRun(sweep)).toContain('| brust | D | 2 |')
})

test('--publish keeps the RESULTS.json shape the website and scripts/m2-exit read', () => {
  const legacy = legacyResults(fixture('run'))
  expect(legacy.header.conn).toBe(120)
  expect(legacy.measurements.find((m) => m.app === 'brust' && m.probe === 'S')?.nums.rps).toBe(500)
  expect(legacy.actions?.measurements[0]).toMatchObject({ app: 'brust', probe: 'A1', conn: 1 })
})

test('/proc/<pid>/stat: a comm with spaces and parentheses, utime + stime in seconds', () => {
  const line = '1234 (bun (worker) x) S 1 1200 1200 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 9 0 100 0 0'
  expect(parseStat(line, 100)).toEqual({ ppid: 1, pgrp: 1200, cpu: 3 })
  expect(parseStat('garbage', 100)).toBeNull()
})

const savedEnv = { rt: process.env.BENCH_NEXT_RUNTIME, path: process.env.PATH }
afterEach(() => {
  if (savedEnv.rt === undefined) delete process.env.BENCH_NEXT_RUNTIME
  else process.env.BENCH_NEXT_RUNTIME = savedEnv.rt
  process.env.PATH = savedEnv.path
})

test('Next without node: Bun is chosen and labelled with its own version; node demanded but absent is a reason, not a crash', () => {
  process.env.BENCH_NEXT_RUNTIME = 'bun'
  expect(nextRuntime()).toEqual({ name: 'bun', version: Bun.version })
  process.env.BENCH_NEXT_RUNTIME = 'deno'
  expect(() => nextRuntime()).toThrow(/must be node or bun/)
  delete process.env.BENCH_NEXT_RUNTIME
  process.env.PATH = '/nonexistent'
  expect(nextRuntime()).toEqual({ name: 'bun', version: Bun.version })
  process.env.BENCH_NEXT_RUNTIME = 'node'
  expect(() => nextRuntime()).toThrow(/node is not on PATH/)
  // the guard asks for node only when the run needs it
  const base = { loadavg1: 1, loadavg5: 1, cores: 8, ohaOnPath: true, releaseAddonDeclared: true, addonPresent: true, nodeVersion: null }
  expect(evaluateGuards({ ...base, needNode: false })).toEqual({ ok: true })
  expect(evaluateGuards({ ...base, needNode: true })).toMatchObject({ ok: false, code: 1 })
})
