// tests/server/pokedex.test.ts — spec §10 integration assertions against the real CLI. Run alone:
// `bun test --timeout 120000 tests/server/pokedex.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  expect(html.startsWith('<!doctype html>')).toBe(true) // F392
  expect(html.slice(15).trimStart().startsWith('<html')).toBe(true)
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
  expect(html).toMatch(/<brust-island style="display:contents" data-id="teamBuilder_[0-9a-f]{8}"(?: x-props='[^']*')?>[\s\S]*My team/)
  expect(html).toMatch(/data-testid="team-count"[^>]*>0</)
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
  expect(a1.job.misses - before.job.misses).toBe(2)                      // detailPage j0 + the AddToTeamButton precompute are new
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

test('catch-all is a static document: 404, 0 Bun calls on the first request, no runtime script (only the nav tag); public files served', async () => {
  const b = await srv.stats()
  const { r, html } = await get('/nope/really')
  expect(r.status).toBe(404)
  expect(html).toContain('<title>Not found · PokéDex</title>')
  // F453: the only script of an all-static page is the nav module, so a click on its links still navigates in place.
  expect([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual([expect.stringMatching(/^\/_brust\/client\/nav-[0-9a-f]{10}\.js$/)])
  expect(html.match(/<script/g)).toHaveLength(1)
  expect(html).not.toContain('brust-island')
  expect(await srv.stats()).toMatchObject({ loader_calls: b.loader_calls, job_calls: b.job_calls })
  const fav = await fetch(`${srv.base}/public/favicon.svg`)
  expect(fav.status).toBe(200)
})

test('global CSS: app.css is imported, not prebuilt: every page (the 404 included) links the hashed stylesheet exactly once, never /public/app.css', async () => {
  const hrefs = new Set<string>()
  for (const p of ['/', '/pokedex', '/pokemon/pikachu', '/type-chart', '/unified', '/nope/really']) {
    const { html } = await get(p)
    const links = [...html.matchAll(/<link [^>]*rel="stylesheet"[^>]*href="(\/_brust\/client\/app-[0-9a-f]{10}\.css)"/g)].map((m) => m[1]!)
    expect([p, links.length]).toEqual([p, 1])
    expect([p, /\/public\/app\.css/.test(html)]).toEqual([p, false])
    hrefs.add(links[0]!)
  }
  expect(hrefs.size).toBe(1) // the same file on every page
  const css = await fetch(`${srv.base}${[...hrefs][0]}`)
  expect(css.status).toBe(200)
  expect(css.headers.get('content-type')).toContain('text/css')
  expect(css.headers.get('cache-control')).toContain('immutable')
  const text = await css.text()
  // the pokedex's own tokens (app.css @theme) and a custom variant (data-mode dark), not just Tailwind's defaults
  expect(text).toContain('--color-brand-500:')
  expect(text).toContain('.bg-brand-500{')
  expect(text).toContain('[data-mode=dark]')
  expect((await fetch(`${srv.base}/public/app.css`)).status).toBe(404)
})

test('cookie mode=light reaches the first paint', async () => {
  const r = await fetch(`${srv.base}/`, { headers: { cookie: 'mode=light' } })
  expect(await r.text()).toMatch(/<html [^>]*lang="en"[^>]*data-mode="light"/)
})

const storeTags = (html: string) => [...html.matchAll(/<script type="application\/json" data-brust-store="([^"]+)">([^<]*)<\/script>/g)].map((m) => ({ name: m[1]!, json: JSON.parse(m[2]!) as unknown, at: m.index! }))

test('first paint: every layout page carries ONE data-brust-store="team" tag = the DB roster, before the runtime script; the TeamBuilder SSR count equals it', async () => {
  for (const p of ['/', '/pokedex', '/type-chart', '/pokemon/nothing']) {
    const { html } = await get(p)
    const tags = storeTags(html).filter((t) => t.name === 'team')
    expect(tags, p).toHaveLength(1)
    expect(tags[0]!.json, p).toEqual({ max: 6, members: [] })
    expect(tags[0]!.at, p).toBeLessThan(html.search(/<script[^>]*\/_brust\/client\/runtime-/))
    expect(html, p).toMatch(/data-testid="team-count"[^>]*>0</)
  }
  expect(storeTags((await get('/nope')).html)).toHaveLength(0)   // the catch-all sits outside the layout
})

test('detail page: AddToTeamButton paints the store state on first paint', async () => {
  const { html } = await get('/pokemon/pikachu?nocache=1')
  const tag = /<button[^>]*data-testid="add-to-team"[^>]*>[\s\S]*?<\/button>/.exec(html)
  expect(tag, 'button painted').not.toBeNull()
  expect(tag![0]).toContain('Add to team')
  expect(tag![0]).not.toMatch(/\sdisabled[\s=>]/)   // the bare attribute, not the `disabled:` utility class or x-bind-disabled
  expect(tag![0]).toMatch(/x-data="addToTeamButton_[0-9a-f]{8}" x-props='\{&quot;id&quot;:25\}'/)
  expect((await get('/pokemon/nothing')).html).not.toContain('add-to-team')
})

test('/unified?start=5: one unified tag {count:5}; island, native counter and read-only node all paint 5; /unified paints 0; a team tag too', async () => {
  const { r, html } = await get('/unified?start=5')
  expect(r.status).toBe(200)
  const tags = storeTags(html)
  expect(tags.filter((t) => t.name === 'unified').map((t) => t.json)).toEqual([{ count: 5 }])
  expect(tags.filter((t) => t.name === 'team')).toHaveLength(1)
  const text = (h: string, id: string) => new RegExp(`data-testid="unified-${id}-count"[^>]*>\\s*([0-9]+)\\s*<`).exec(h)?.[1]
  expect(['island', 'native', 'node'].map((id) => text(html, id))).toEqual(['5', '5', '5'])
  const zero = (await get('/unified')).html
  expect(['island', 'native', 'node'].map((id) => text(zero, id))).toEqual(['0', '0', '0'])
  expect(storeTags(zero).find((t) => t.name === 'unified')!.json).toEqual({ count: 0 })
  expect(storeTags((await get('/unified?start=-9')).html).find((t) => t.name === 'unified')!.json).toEqual({ count: 0 })
  expect(storeTags((await get('/unified?start=99999999')).html).find((t) => t.name === 'unified')!.json).toEqual({ count: 1000000 })
})

// ---- team actions through Rust. LAST in the file on purpose: these mutate the DB, the tests above assume it is empty. ----
type Team = { team: { id: number; name: string; displayName: string; types: string[] }[]; max: number }
const jpost = (id: unknown, srv2 = srv) => srv2.action('/team', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
const roster = async (srv2 = srv) => ((await (await srv2.action('/team')).json()) as Team).team.map((m) => m.id)
async function reset() { for (const id of await roster()) await srv.action(`/team/${id}`, { method: 'DELETE' }) }

describe('team actions through Rust', () => {
  test('GET lists, POST adds (member from the snapshot), POST is idempotent', async () => {
    await reset()
    const g = await srv.action('/team')
    expect(g.status).toBe(200)
    expect(g.headers.get('content-type')).toContain('application/json')
    expect(await g.json()).toEqual({ team: [], max: 6 })
    const p = await jpost(25)
    expect(p.status).toBe(200)
    const j = (await p.json()) as Team
    expect(j.team[0]).toMatchObject({ id: 25, name: 'pikachu', displayName: 'Pikachu', types: ['electric'] })
    expect((await jpost(25)).status).toBe(200)
    expect(await roster()).toEqual([25])
  })

  test('409 TeamFull at six: application/problem+json {title, status, max}; a member re-POST is 200; DELETE removes', async () => {
    await reset()
    for (const id of [1, 4, 7, 39, 94, 143]) expect((await jpost(id)).status).toBe(200)
    const full = await jpost(25)
    expect(full.status).toBe(409)
    expect(full.headers.get('content-type')).toContain('application/problem+json')
    expect(await full.json()).toMatchObject({ title: 'TeamFull', status: 409, max: 6 })
    expect((await jpost(4)).status).toBe(200)
    const d = await srv.action('/team/4', { method: 'DELETE' })
    expect(d.status).toBe(200)
    expect(await roster()).toEqual([1, 7, 39, 94, 143])
  })

  test("422 for a bad body (production shape: no errors member); 404 problem for an unknown id; PUT /team is Elysia's 404; POST / is still 405", async () => {
    const bad = await jpost('x')
    expect(bad.status).toBe(422)
    expect(bad.headers.get('content-type')).toContain('application/problem+json')
    expect(await bad.json()).not.toHaveProperty('errors')
    const unknown = await jpost(999)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ title: 'UnknownPokemon' })
    expect((await srv.action('/team', { method: 'PUT' })).status).toBe(404)
    expect((await fetch(`${srv.base}/`, { method: 'POST' })).status).toBe(405)
  })

  test('F87: a cross-site POST is a 403 problem from Rust and changes nothing; same-origin and Origin-less POSTs pass', async () => {
    await reset()
    const hdr = { 'content-type': 'application/json' }
    const body = JSON.stringify({ id: 25 })
    const evil = await srv.action('/team', { method: 'POST', headers: { ...hdr, origin: 'https://evil.example' }, body })
    expect(evil.status).toBe(403)
    expect(evil.headers.get('content-type')).toContain('application/problem+json')
    expect(await evil.json()).toMatchObject({ title: 'CrossSiteRejected', status: 403 })
    const form = await srv.action('/team', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, body: 'id=25' })
    expect(form.status).toBe(403)
    expect(await roster()).toEqual([])
    expect((await srv.action('/team', { method: 'POST', headers: { ...hdr, origin: new URL(srv.base).host.replace(/^/, 'http://') }, body })).status).toBe(200)
    await reset()
  })

  test('20 concurrent POSTs of distinct ids across 2 workers add exactly 6', async () => {
    await reset()
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => jpost(i + 1)))
    const codes = rs.map((r) => r.status)
    expect(codes.filter((c) => c === 200)).toHaveLength(6)
    expect(codes.filter((c) => c === 409)).toHaveLength(14)
    expect(await roster()).toHaveLength(6)
  })

  test('L1: a mutation evicts the team tag (pokemon and type-chart), then the page is fresh and cached again', async () => {
    await reset()
    await get('/type-chart')
    const a = await get('/pokemon/snorlax')
    expect(a.r.headers.get('x-brust-cache')).toBe('MISS')
    expect((await get('/pokemon/snorlax')).r.headers.get('x-brust-cache')).toBe('HIT')
    expect((await get('/type-chart')).r.headers.get('x-brust-cache')).toBe('HIT')
    expect((await jpost(143)).status).toBe(200)
    const b = await get('/pokemon/snorlax')
    expect(b.r.headers.get('x-brust-cache')).toBe('MISS')
    expect(storeTags(b.html).find((t) => t.name === 'team')!.json).toMatchObject({ max: 6, members: [{ id: 143 }] })
    expect(b.html).toMatch(/data-testid="add-to-team"[^>]*>In your team</)
    const c = await get('/pokemon/snorlax')
    expect(c.r.headers.get('x-brust-cache')).toBe('HIT')
    expect(c.html).toBe(b.html)
    const t = await get('/type-chart')
    expect(t.r.headers.get('x-brust-cache')).toBe('MISS')
    expect(t.html).toMatch(/data-testid="team-count"[^>]*>1</)
  })

  test('?nocache=1 always reflects the DB', async () => {
    await jpost(143)
    expect((await get('/pokemon/snorlax?nocache=1')).html).toMatch(/data-testid="add-to-team"[^>]*>In your team</)
    await srv.action('/team/143', { method: 'DELETE' })
    expect((await get('/pokemon/snorlax?nocache=1')).html).toMatch(/data-testid="add-to-team"[^>]*>Add to team</)
  })

  test('restart keeps the team', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-restart-'))
    const db = join(dir, 'team.sqlite')
    let s1: typeof srv | undefined
    let s2: typeof srv | undefined
    try {
      s1 = await startPokedex({ build: false, db })
      for (const id of [25, 4]) expect((await jpost(id, s1)).status).toBe(200)
      await s1.stop()
      s1 = undefined
      s2 = await startPokedex({ build: false, db })
      expect(await roster(s2)).toEqual([25, 4])
      expect(await (await fetch(`${s2.base}/`)).text()).toMatch(/data-testid="team-count"[^>]*>2</)
    } finally {
      await s1?.stop()
      await s2?.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
