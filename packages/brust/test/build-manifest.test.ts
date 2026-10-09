import { afterAll, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beginDrain, cacheStats, localAddr, registerWorker, startServer, untilReady } from '../native/index.js'
import { runBuild } from '../src/build'
import { flattenRoutes } from '../src/routes'
import { type JobsModule, makeDispatch, makeHandlers } from '../src/worker'

const app = join(import.meta.dir, 'fixtures/app')
const dist = join(app, 'dist')
const pinFile = join(import.meta.dir, 'fixtures/app.expected-manifest.json')
const shapes = join(import.meta.dir, 'fixtures/shapes')
const childChunks = join(import.meta.dir, 'fixtures/child-chunks')

// Generated `dist/jobs/*.server.ts` keep the compiler's relative imports (resolved against the
// SOURCE dir only at bundle time): left under `test/`, they would fail `tsc`. Not kept.
afterAll(() => {
  for (const d of [dist, join(shapes, 'dist'), join(childChunks, 'dist')]) rmSync(d, { recursive: true, force: true })
})

/** Content hashes depend on the bundler, React and runtime-dom bytes, not on the contract: the
 * pin compares everything else. `BRUST_UPDATE_PIN=1` regenerates the pin (then review it). */
/** Bun's `toMatchObject` writes asymmetric matchers INTO the received object: assert on a copy. */
const clone = <T>(v: T): T => structuredClone(v)
const unhash = (m: unknown) => JSON.parse(JSON.stringify(m).replace(/-[0-9a-f]{10}\.js/g, '-<hash>.js'))

/** Boots `distDir` through the real server (`Manifest::load`) with one in-process worker running
 * the real handlers over the built `jobs.js`, the app's routes and the manifest. */
async function serve(appDir: string) {
  const d = join(appDir, 'dist')
  const manifest = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'))
  const jobs = (await import(join(d, manifest.jobs_module))).default as JobsModule
  const { leaves } = flattenRoutes((await import(join(appDir, 'routes.tsx'))).routes)
  startServer({ host: '127.0.0.1', port: 0, distDir: d, workers: 1, claimTimeoutMs: 2000 })
  const slots = 2
  const view = new Uint8Array(new SharedArrayBuffer(256 * 1024 * slots))
  registerWorker(view, slots, makeDispatch(makeHandlers({ leaves, jobs, manifest }), view, slots))
  await untilReady(2000)
  return { base: `http://${localAddr()}`, manifest, view }
}

test('brust build writes the S6 manifest (pinned) and every file it names', async () => {
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: 'dist', log: () => {} })
  const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  if (process.env.BRUST_UPDATE_PIN === '1') writeFileSync(pinFile, `${JSON.stringify(unhash(m), null, 2)}\n`)
  expect(unhash(m)).toEqual(JSON.parse(readFileSync(pinFile, 'utf8')))

  // Structural rules independent of the pinned bytes:
  const item = m.components[m.routes[1].chain[1]]
  expect(m.routes.map((r: any) => [r.id, r.pattern, r.loaders, r.catch_all])).toEqual([
    ['r1', '/', [], false],
    ['r2', '/items/{id}', ['r2'], false],
  ])
  expect(m.routes[1].cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: null, tags: ['items'] })
  expect(clone(item.jobs[0])).toMatchObject({ id: 'j0', kind: 'precompute', inputs: ['item.price', 'unit'], outputs: ['_s1'], per_instance: null })
  expect(clone(item.jobs[1])).toMatchObject({
    id: 'j1',
    kind: 'ssr',
    inputs: ['team'],
    outputs: [expect.stringMatching(/^_ssr_team_/)],
    target: expect.stringMatching(/^team_/),
    props: { team: 'team' },
  })
  expect(clone(item.children)).toEqual([{ id: expect.stringMatching(/^priceRow_/), instances: 'per-row:item.rows', props: { item: 'item.rows[idx]', unit: 'unit' } }])
  expect(item.use_id_slots).toBe(1)
  expect(clone(m.components[item.jobs[1].target])).toMatchObject({
    tier: 'react',
    client: expect.stringMatching(/^client\/react-team_[0-9a-f]{8}-[0-9a-f]{10}\.js$/),
    jobs: [{ kind: 'ssr', inputs: ['*'], target: item.jobs[1].target }],
  })
  expect(m.assets.react).toBeUndefined()
  for (const p of [m.assets.runtime, ...Object.values(m.components).map((c: any) => c.client).filter(Boolean), 'jobs.js', 'public/app.css', 'index.js'])
    expect(existsSync(join(dist, p))).toBe(true)
  for (const c of Object.values(m.components) as any[]) expect(existsSync(join(dist, c.template))).toBe(true)
  for (const f of readdirSync(join(dist, 'client'))) expect(f).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]*-[0-9a-f]{10}\.js$/) // pipeline.rs safe_rel + is_hashed
  expect(existsSync(join(dist, '.stage'))).toBe(false)
  // Client chunks import the runtime by the URL the manifest names; the runtime mounts the document.
  expect(readFileSync(join(dist, item.client), 'utf8')).toContain(`"/_brust/${m.assets.runtime}"`)
  expect(readFileSync(join(dist, m.assets.runtime), 'utf8')).toContain('document.documentElement')
  const jobs = (await import(join(dist, 'jobs.js'))).default
  expect(jobs[item.children[0].id].precompute({ item: { price: 2.25 }, unit: '€' })).toEqual({ _s1: '2.3€' })
  expect(jobs[item.jobs[1].target].ssr({ team: ['ann'], title: 't' })).toContain('<span>ann</span>')
  // Ruling 2bf3775a (R1): useId is prefixed by the island's component id on BOTH sides.
  const target = item.jobs[1].target
  const prefixed = new RegExp(`identifierPrefix:\\s*"${target}"`)
  expect(readFileSync(join(dist, 'jobs.js'), 'utf8')).toMatch(prefixed)
  expect(readFileSync(join(dist, m.components[target].client), 'utf8')).toMatch(prefixed)
})

test('the generated dist passes Manifest::load and renders through the real handlers (slot names line up)', async () => {
  const { base } = await serve(app)
  const home = await fetch(`${base}/`)
  expect(home.status).toBe(200)
  const homeHtml = await home.text()
  expect(homeHtml).toContain('<section><h1>Home</h1></section>')
  expect(JSON.parse(cacheStats()).loader_calls).toBe(0)

  const res = await fetch(`${base}/items/x`)
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('<h1 id="brust-r2-itemPage_b7278c7c-1"')
  expect(html).toContain('<p class="total">12.5€</p>') // page precompute j0 → _s1
  // Per-row child precompute: each row painted with ITS value (Review Focus 1).
  expect(html.match(/<li x-data="priceRow_042dcbca"[^>]*>([^<]*)<\/li>/g)?.map((s) => s.replace(/<[^>]+>/g, ''))).toEqual(['1.0€', '2.3€'])
  // React child ssr job on the parent (D6 outputs/target/props).
  expect(html).toContain('<brust-island data-id="team_db295766"')
  expect(html).toMatch(/<span>ann<\/span><span>bob<\/span>/)
  // m2a3 literals: the constant prop reaches the child's ssr through the manifest + worker merge.
  expect(html).toContain('<h3>crew</h3>')
  expect(html).toContain('/_brust/client/runtime-')
  expect(html).toContain('/_brust/client/react-team_db295766-')
  const chunk = /\/_brust\/(client\/itemPage_[^"]+\.js)/.exec(html)![1]!
  const js = await fetch(`${base}/_brust/${chunk}`)
  expect(js.status).toBe(200)
  expect(js.headers.get('cache-control')).toContain('immutable')
  await js.text()
  await beginDrain(1000)
})

test('cache(), a per-row react child and a client_only child map to S6 (and pass Manifest::load)', async () => {
  await runBuild({ appRoot: shapes, entry: 'routes.tsx', outDir: 'dist', log: () => {} })
  const { base, manifest: m } = await serve(shapes)
  const page = m.components[m.routes[0].chain[0]]
  const [badge, clock] = ['badge_', 'clock_'].map((p) => Object.keys(m.components).find((id) => id.startsWith(p))!) as [string, string]
  expect(page.jobs).toEqual([
    {
      id: 'j0',
      kind: 'ssr',
      inputs: ['items'],
      outputs: [`_ssr_${badge}`],
      target: badge,
      props: { label: 'items[idx].name' },
      per_instance: 'items', // the list's context path, not `_l1`
      cache: { key: 'page.id', tags: ['list'], ttl_seconds: 30 },
    },
  ])
  // client_only: no ssr job anywhere for it, a static children[] entry so its chunk is linked.
  expect(page.children).toEqual([{ id: clock, instances: 'static', props: {} }])
  expect(clone(m.components[clock])).toMatchObject({ tier: 'react', jobs: [], client: expect.stringMatching(/^client\/react-clock_/) })
  expect(clone(m.components[badge].jobs)).toMatchObject([{ id: 'j0', kind: 'ssr', inputs: ['*'], target: badge }])

  const html = await (await fetch(`${base}/list`)).text()
  expect(html.match(/<b>.*?<\/b>/g)).toEqual(['<b>Ann<!-- -->:<!-- -->0</b>', '<b>Bob<!-- -->:<!-- -->0</b>'])
  expect(html).toContain(`<brust-island data-id="${clock}" x-props='{}'></brust-island>`)
  expect(html).toContain(`/_brust/${m.components[clock].client}`)
  await beginDrain(1000)
})

test('every chunk-bearing native descendant of a chain component is linked once via a static children[] entry (F66)', async () => {
  await runBuild({ appRoot: childChunks, entry: 'routes.tsx', outDir: 'dist', log: () => {} })
  const m = JSON.parse(readFileSync(join(childChunks, 'dist/manifest.json'), 'utf8'))
  const idOf = (p: string) => Object.keys(m.components).find((id) => id.startsWith(p))!
  const [page, toggle, deep, counted, stat, allStatic] = ['page_', 'toggle_', 'deep_', 'counted_', 'static_', 'allStatic_'].map(idOf) as string[]
  expect(m.routes.map((r: any) => r.chain)).toEqual([[page], [allStatic]])
  for (const id of [toggle, deep, counted]) expect(clone(m.components[id!])).toMatchObject({ tier: 'native', client: expect.stringMatching(/^client\//) })
  expect(m.components[stat!].client).toBeNull()
  // Counted keeps its instances[] record (useId); Toggle (×2) and Deep (via Toggle AND Counted)
  // get one static entry each, in IR child order; Static (no chunk) gets none.
  expect(m.components[page!].children).toEqual([
    { id: counted, instances: 'static', props: {} },
    { id: toggle, instances: 'static', props: {} },
    { id: deep, instances: 'static', props: {} },
  ])
  // Non-chain records keep only their instances-derived children (the server walks chain children).
  for (const id of [toggle, deep, counted, stat]) expect(m.components[id!].children).toEqual([])
  // An all-static chain links nothing.
  expect(m.components[allStatic!].children).toEqual([])
})
