// tests/server/pokedex.test.ts — spec §10 integration assertions against the real CLI. Run alone:
// `bun test --timeout 120000 tests/server/pokedex.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, startPokedex } from './harness'

let srv: Awaited<ReturnType<typeof startPokedex>>
beforeAll(async () => { srv = await startPokedex() }, 120_000)
afterAll(async () => { try { await srv?.stop() } finally { rmSync(join(app, 'dist'), { recursive: true, force: true }) } })
const get = async (p: string) => { const r = await fetch(`${srv.base}${p}`); return { r, html: await r.text() } }
const scripts = (html: string) => [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!)

test('/: 200, document root, HeroSearch useId stable across two requests, all 18 TypeBadges painted, island SSR + chunk', async () => {
  const { r, html } = await get('/')
  expect(r.status).toBe(200)
  expect(html.trimStart().startsWith('<html')).toBe(true)
  expect(html).toMatch(/<html [^>]*lang="en"[^>]*data-mode="dark"/)
  expect(html).toMatch(/<title[^>]*>PokéDex · built with brust<\/title>/)
  expect(html).toContain('Every Pokémon')
  // useId (F39): label/input share the server id and it is identical on a second request.
  const id = /<label for="(brust-r1-[^"]+)"/.exec(html)![1]!
  expect(html).toContain(`<input id="${id}"`)
  expect((await get('/')).html).toContain(`<label for="${id}"`)
  // Per-row TypeBadge (one job per type, batched): 18 chips in ALL_TYPES order with the helper's colours.
  const chips = [...html.matchAll(/data-type="([a-z]+)"[^>]*style="background:\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]])
  expect(chips.length).toBe(18)
  expect(chips[0]).toEqual(['normal', '#9099a1']); expect(chips[3]).toEqual(['electric', '#f5c84b'])
  // React child (S12): SSR HTML inside the host, its chunk linked, the runtime linked.
  expect(html).toMatch(/<brust-island data-id="teamBuilder_[0-9a-f]{8}" x-props='[^']*'>[\s\S]*My team/)
  expect(html).toMatch(/data-testid="team-count"[^>]*>2</)
  const s = scripts(html)
  expect(s.some((u) => /\/_brust\/client\/runtime-[0-9a-f]{10}\.js$/.test(u))).toBe(true)
  expect(s.some((u) => /\/_brust\/client\/react-teamBuilder_[0-9a-f]{8}-[0-9a-f]{10}\.js$/.test(u))).toBe(true)
  const st = await srv.stats()
  expect(st.loader_calls).toBe(2)   // no route cache on /: the loader runs per request
  expect(st.job_calls).toBe(1)      // one batched jobs call; the second request is all job-cache hits
})

test('/pokedex: every DexCard row painted in dex order with per-row props; ?q= filters in the loader', async () => {
  const { r, html } = await get('/pokedex')
  expect(r.status).toBe(200)
  const nums = [...html.matchAll(/data-dex="(#\d{4})"/g)].map((m) => m[1])
  expect(nums.length).toBe(151); expect(nums[0]).toBe('#0001'); expect(nums[150]).toBe('#0151')
  expect(html.indexOf('Bulbasaur')).toBeLessThan(html.indexOf('Ivysaur'))
  const count = html.slice(html.indexOf('data-testid="count"')).slice(0, 300).replace(/<[^>]*>/g, '')
  expect(count).toContain('151 / 151')
  const q = await get('/pokedex?q=pika')
  expect([...q.html.matchAll(/data-dex="#/g)].length).toBe(1)
  expect(q.html).toContain('Results for “pika”')
})

test('job cache HIT across two routes sharing a component and inputs; /pokemon/{name} is an L1 HIT on the second request', async () => {
  const before = await srv.stats()
  const { r: r1, html: h1 } = await get('/pokemon/pikachu')
  expect(r1.status).toBe(200)
  expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  expect(h1).toMatch(/<title[^>]*>Pikachu · PokéDex<\/title>/)
  expect(h1).toContain('Mouse Pokémon')
  expect(h1).toContain('0.4 m'); expect(h1).toContain('6.0 kg')            // detailPage j0 (fmtHeight/fmtWeight)
  expect(h1).toMatch(/data-type="electric"[^>]*style="background:\s*#f5c84b/)   // the same TypeBadge job `/` already ran
  const a1 = await srv.stats()
  expect(a1.loader_calls - before.loader_calls).toBe(1)
  expect(a1.job.hits - before.job.hits).toBeGreaterThanOrEqual(2)        // typeBadge{electric} + teamBuilder ssr
  expect(a1.job.misses - before.job.misses).toBe(1)                      // only detailPage j0 is new
  const { r: r2, html: h2 } = await get('/pokemon/pikachu')
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  expect(h2).toBe(h1)
  const a2 = await srv.stats()
  expect(a2.loader_calls).toBe(a1.loader_calls); expect(a2.job_calls).toBe(a1.job_calls)
  expect(a2.l1.hits - a1.l1.hits).toBe(1)
  // ?nocache=1 bypasses L1 (bench probe B): loader again, no job call (every job is cached).
  const { r: r3 } = await get('/pokemon/pikachu?nocache=1')
  expect(r3.headers.get('x-brust-cache')).not.toBe('HIT')
  const a3 = await srv.stats()
  expect(a3.loader_calls - a2.loader_calls).toBe(1); expect(a3.job_calls).toBe(a2.job_calls)
})

test('per-row child values painted per row: bulbasaur = grass then poison (F34 __typeBadge_k array)', async () => {
  const { html } = await get('/pokemon/bulbasaur')
  const chips = [...html.matchAll(/data-type="([a-z]+)"[^>]*style="background:\s*(#[0-9a-f]{6})/g)].map((m) => `${m[1]}:${m[2]}`)
  expect(chips).toEqual(['grass:#63bb5b', 'poison:#ab6ac8'])
  expect(html).toContain('0.7 m')
})

test('/pokemon/nothing: loader notFound renders the route template at 404, never cached', async () => {
  const { r, html } = await get('/pokemon/nothing')
  expect(r.status).toBe(404)
  expect(html).toMatch(/No Pokémon named “Nothing”/) // F70: DetailPage is static, no x-text wrapper
  expect(html).toMatch(/<title[^>]*>Nothing · PokéDex<\/title>/)
  const again = await get('/pokemon/nothing')
  expect(again.r.status).toBe(404); expect(again.r.headers.get('x-brust-cache')).toBe('MISS')
})

test('/type-chart: one loader call and no job call on the first request (every job cached), then an L1 HIT with no Bun call', async () => {
  const b = await srv.stats()
  const { r, html } = await get('/type-chart')
  expect(r.status).toBe(200)
  expect(html).toMatch(/<h1 [^>]*>Type chart<\/h1>/)
  expect(html).toContain('Fire → Grass: 2× (super effective)')
  expect(scripts(html).some((u) => /typeChart_/.test(u))).toBe(false)      // static leaf: no chunk of its own
  const a = await srv.stats()
  expect(a.loader_calls - b.loader_calls).toBe(1); expect(a.job_calls).toBe(b.job_calls)
  const second = await get('/type-chart')
  expect(second.r.headers.get('x-brust-cache')).toBe('HIT')
  const c = await srv.stats()
  expect(c.loader_calls).toBe(a.loader_calls); expect(c.job_calls).toBe(a.job_calls)
})

test('catch-all is a static document: 404, 0 Bun calls on the first request, no script tag at all; public files served', async () => {
  const b = await srv.stats()
  const { r, html } = await get('/nope/really')
  expect(r.status).toBe(404)
  expect(html).toContain('<title>Not found · PokéDex</title>')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('brust-island')
  expect(await srv.stats()).toMatchObject({ loader_calls: b.loader_calls, job_calls: b.job_calls })
  const css = await fetch(`${srv.base}/public/app.css`)
  expect(css.status).toBe(200); expect(css.headers.get('content-type')).toContain('text/css')
})

test('cookie mode=light reaches the first paint', async () => {
  const r = await fetch(`${srv.base}/`, { headers: { cookie: 'mode=light' } })
  expect(await r.text()).toMatch(/<html [^>]*lang="en"[^>]*data-mode="light"/)
})
