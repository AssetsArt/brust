// website/test/landing.test.ts — the landing builds clean, `/` serves, the three demos compile to the tier the page claims, and every benchmark
// number on the page comes from bench/RESULTS.json (never hard-coded).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBench } from '../lib/bench'
import { freshOut, HOOK_MS, serve, type Server } from './harness'

const app = join(import.meta.dir, '..')
const bin = join(app, '../packages/brust/bin/brust')
let OUT = ''
const results = JSON.parse(readFileSync(join(app, '../bench/RESULTS.json'), 'utf8'))

interface Manifest {
  routes: { pattern: string }[]
  components: Record<string, { tier: string; client: string | null; jobs: { kind: string }[] }>
}
let manifest: Manifest
let srv: Server | undefined
let base = ''
let html = ''

/** Component record by source name (`catchCard_<hash>` → `CatchCard`). */
function component(name: string) {
  const prefix = `${name[0]!.toLowerCase()}${name.slice(1)}_`
  const hits = Object.entries(manifest.components).filter(([id]) => id.startsWith(prefix))
  expect([name, hits.length]).toEqual([name, 1])
  return hits[0]![1]
}

beforeAll(async () => {
  OUT = freshOut('landing')
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', OUT], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'))
  srv = await serve(OUT, 1)
  base = srv.base
  html = await (await fetch(`${base}/`)).text()
}, HOOK_MS)

afterAll(async () => {
  await srv?.stop()
  freshOut('landing')
}, HOOK_MS)

test('route / serves 200 as the landing, an unknown route is 404', async () => {
  expect(manifest.routes.map((r) => r.pattern)).toContain('/')
  const r = await fetch(`${base}/`)
  expect(r.status).toBe(200)
  expect(r.headers.get('x-powered-by')).toMatch(/^brust\//)
  expect(html).toContain('React you write.')
  expect((await fetch(`${base}/no-such-page`)).status).toBe(404)
})

test('the three demos compile to the tier the page claims: PokemonCard static, CatchCard native, PokemonSearch react', () => {
  const card = component('PokemonCard')
  expect([card.tier, card.jobs.length, card.client]).toEqual(['static', 0, null])
  const catchCard = component('CatchCard')
  expect([catchCard.tier, catchCard.jobs.length]).toEqual(['native', 0])
  expect(catchCard.client).toMatch(/^client\/catchCard_/)
  const search = component('PokemonSearch')
  expect(search.tier).toBe('react')
  expect(search.jobs.map((j) => j.kind)).toEqual(['ssr'])
})

test('the interactive landing pieces are native; the composition is static', () => {
  for (const name of ['Poster', 'TmuxSession', 'CountUp', 'Histogram', 'TierTabs', 'RailFill', 'CopyButton', 'RequestPath']) expect([name, component(name).tier]).toEqual([name, 'native'])
  for (const name of ['HomePage', 'Hero', 'Benchmark', 'BenchCardView', 'PosterScene', 'StaticPanel', 'NativePanel', 'Steps', 'DataSection', 'ActionsStore', 'Deploy', 'Packages', 'Nots', 'Closing'])
    expect([name, component(name).tier]).toEqual([name, 'static'])
})

test('the code shown beside each demo is the demo’s real source file', () => {
  const esc = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  // one distinctive line per demo (no quotes, which the page escapes differently); the page shows the file's own text, plain until lane inner-html lands
  for (const [file, line] of [
    ['PokemonCard', '{types.map((t) => ('],
    ['CatchCard', 'const [caught, setCaught] = useState(0)'],
    ['PokemonSearch', 'const deferred = useDeferredValue(q)'],
  ] as const) {
    expect(readFileSync(join(app, 'components/landing/demos', `${file}.tsx`), 'utf8')).toContain(line)
    expect(html).toContain(esc(line))
  }
})

test('benchmark numbers on the page equal bench/RESULTS.json', () => {
  const rows = ['S', 'I', 'D'].map((probe) => results.measurements.find((m: { app: string; probe: string; enc: string }) => m.app === 'brust' && m.probe === probe && m.enc === 'identity'))
  const int = (n: number) => Math.round(n).toLocaleString('en-US')
  for (const row of rows) {
    expect(html).toContain(int(row.nums.rps))
    expect(html).toContain(row.nums.p50.toFixed(1))
    expect(html).toContain(row.nums.p99.toFixed(1))
    expect(html).toContain(String(Math.round(row.raw.summary.sizePerSec / 1e6)))
    // one bar per histogram bucket, each titled with its real count
    for (const [, count] of Object.entries(row.raw.responseTimeHistogram)) expect(html).toContain(`${(count as number).toLocaleString('en-US')} requests up to`)
  }
  expect(html).toContain(int(rows.reduce((n: number, r: { nums: { total: number } }) => n + r.nums.total, 0)))
  expect(html).toContain(`Measured ${results.header.date}`)
  expect(html).toContain(`${results.header.conn} concurrent connections`)
  expect(html).toContain(`${results.header.workers} workers`)
})

test('parseBench: min bar height 2%, axis units, a re-run moves the numbers', () => {
  const m = (probe: string, rps: number, hist: Record<string, number>) => ({
    app: 'brust',
    probe,
    enc: 'identity',
    nums: { rps, p50: 1.04, p99: 12.34, total: 100, errors: 0, status: { '200': 100 } },
    raw: { summary: { sizePerSec: 5_400_000 }, responseTimeHistogram: hist },
  })
  const fake = {
    header: { date: '2030-01-02', conn: 64, dur: '7s', workers: 3, machine: { model: 'Box', chip: 'Apple Z9' } },
    measurements: [m('S', 1234.4, { '0.0005': 1, '0.002': 100, '0.0035': 50 }), m('I', 1, { '0.001': 1 }), m('D', 2, { '0.5': 5 })],
  }
  const b = parseBench(fake as never)
  expect(b.setup).toEqual({ conn: 64, duration: '7 seconds', workers: 3, machine: 'Box Z9' })
  expect(b.date).toBe('2030-01-02')
  expect(b.hero.text).toBe('1,234')
  expect(b.S.bars.map((x) => x.h)).toEqual(['2.0%', '100.0%', '50.0%'])
  expect([b.S.axisFrom, b.S.axisTo]).toEqual(['0.50 ms', '3.5 ms'])
  expect([b.S.p50.text, b.S.p99.text, b.S.mbps.text]).toEqual(['1.0', '12.3', '5'])
  expect(b.totalRequests).toBe(300)
  expect(b.allOk).toBe(true)
  const bad = { ...fake, measurements: [{ ...m('S', 1, { '0.001': 1 }), nums: { rps: 1, p50: 1, p99: 1, total: 10, errors: 1, status: { '200': 9, '500': 1 } } }, m('I', 1, { '0.001': 1 }), m('D', 1, { '0.001': 1 })] }
  expect(parseBench(bad as never).allOk).toBe(false)
})
