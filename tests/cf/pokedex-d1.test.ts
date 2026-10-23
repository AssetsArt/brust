// M4-CF-5: the pokedex example built `--target cloudflare` and served by local workerd with a persisted local D1.
// Opt-in: BRUST_CF_E2E=1 (builds the pokedex, runs `bunx wrangler`).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrateLocal, startWrangler, type Wrangler } from './pokedex-d1/remote'

const ENABLED = process.env.BRUST_CF_E2E === '1'
const REPO = resolve(import.meta.dir, '../..')
const APP = join(REPO, 'examples/pokedex')
const CONFIG = join(APP, 'dist/cf/wrangler.jsonc')

let w: Wrangler
let state = ''
const get = async (p: string, init?: RequestInit) => {
  const r = await fetch(`${w.base}${p}`, { redirect: 'manual', ...init })
  return { r, html: await r.text() }
}
const action = (p: string, init?: RequestInit) => fetch(`${w.base}/_brust/action${p}`, init)
const jpost = (id: unknown, headers: Record<string, string> = {}) => action('/team', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id }) })
type Team = { team: { id: number; name: string }[]; max: number }
const roster = async () => ((await (await action('/team')).json()) as Team).team.map((m) => m.id)
const reset = async () => {
  for (const id of await roster()) await action(`/team/${id}`, { method: 'DELETE' })
}
const scripts = (html: string) => [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!)
const storeTags = (html: string) => [...html.matchAll(/<script type="application\/json" data-brust-store="([^"]+)">([^<]*)<\/script>/g)].map((m) => ({ name: m[1]!, json: JSON.parse(m[2]!) as unknown }))

describe.skipIf(!ENABLED)('pokedex on local workerd + local D1', () => {
  beforeAll(async () => {
    const build = Bun.spawnSync([process.execPath, join(REPO, 'packages/brust/src/cli.ts'), 'build', 'routes.tsx', '--target', 'cloudflare'], {
      cwd: APP,
      env: { ...process.env, BRUST_CORE_CF_DIR: join(REPO, 'npm/core-cf') },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (build.exitCode !== 0) throw new Error(`brust build --target cloudflare exited ${build.exitCode} (is npm/core-cf/worker built? bun crates/brust-wasm/scripts/build.ts)`)
    state = mkdtempSync(join(tmpdir(), 'pokedex-d1-e2e-'))
    migrateLocal(CONFIG, state)
    w = await startWrangler({ config: CONFIG, state })
  }, 600_000)
  afterAll(async () => {
    try {
      await w?.stop()
    } finally {
      rmSync(state, { recursive: true, force: true })
      rmSync(join(APP, 'dist'), { recursive: true, force: true })
    }
  })

  test('1 GET / renders: document root, island SSR with team count 0, runtime + island chunk linked', async () => {
    const { r, html } = await get('/')
    expect(r.status).toBe(200)
    expect(html.startsWith('<!doctype html>')).toBe(true) // F392
    expect(html.slice(15).trimStart().startsWith('<html')).toBe(true)
    expect(html).toMatch(/<brust-island data-id="teamBuilder_[0-9a-f]{8}"(?: x-props='[^']*')?>[\s\S]*My team/)
    expect(html).toMatch(/data-testid="team-count"[^>]*>0</)
    const s = scripts(html)
    expect(s.some((u) => /\/_brust\/client\/runtime-[0-9a-f]{10}\.js$/.test(u))).toBe(true)
    expect(s.some((u) => /\/_brust\/client\/react-teamBuilder_[0-9a-f]{8}-[0-9a-f]{10}\.js$/.test(u))).toBe(true)
  })

  test('2 /pokemon/pikachu: MISS then an identical L1 HIT', async () => {
    const a = await get('/pokemon/pikachu')
    expect(a.r.status).toBe(200)
    expect(a.r.headers.get('x-brust-cache')).toBe('MISS')
    expect(a.html).toMatch(/<title[^>]*>Pikachu · PokéDex<\/title>/)
    expect(a.html).toContain('0.4 m')
    expect(a.html).toMatch(/data-testid="add-to-team"[^>]*>Add to team</)
    const b = await get('/pokemon/pikachu')
    expect(b.r.headers.get('x-brust-cache')).toBe('HIT')
    expect(b.html).toBe(a.html)
  })

  test('3 /unified?start=5 paints 5 on the island, the native counter and the node', async () => {
    const { r, html } = await get('/unified?start=5')
    expect(r.status).toBe(200)
    const text = (id: string) => new RegExp(`data-testid="unified-${id}-count"[^>]*>\\s*([0-9]+)\\s*<`).exec(html)?.[1]
    expect(['island', 'native', 'node'].map(text)).toEqual(['5', '5', '5'])
  })

  test('4 team actions: GET empty, POST adds, POST again is idempotent', async () => {
    await reset()
    const g = await action('/team')
    expect(g.status).toBe(200)
    expect(await g.json()).toEqual({ team: [], max: 6 })
    const p = await jpost(25)
    expect(p.status).toBe(200)
    expect(((await p.json()) as Team).team[0]).toMatchObject({ id: 25, name: 'pikachu' })
    expect((await jpost(25)).status).toBe(200)
    expect(await roster()).toEqual([25])
  })

  test('5 409 TeamFull at six, a member re-POST is 200, DELETE removes', async () => {
    await reset()
    for (const id of [25, 1, 7, 39, 94, 4]) expect((await jpost(id)).status).toBe(200)
    const full = await jpost(143)
    expect(full.status).toBe(409)
    expect(full.headers.get('content-type')).toContain('application/problem+json')
    expect(await full.json()).toMatchObject({ title: 'TeamFull', status: 409, max: 6 })
    expect((await jpost(4)).status).toBe(200)
    expect((await action('/team/4', { method: 'DELETE' })).status).toBe(200)
    expect(await roster()).toEqual([25, 1, 7, 39, 94])
  })

  test('6 F87: a cross-site POST is 403 CrossSiteRejected and changes nothing; an Origin-less POST passes', async () => {
    await reset()
    const evil = await jpost(25, { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    expect(await evil.json()).toMatchObject({ title: 'CrossSiteRejected', status: 403 })
    const form = await action('/team', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, body: 'id=25' })
    expect(form.status).toBe(403)
    expect(await roster()).toEqual([])
    expect((await jpost(25)).status).toBe(200)
  })

  test('7 20 concurrent POSTs land exactly 6 on D1', async () => {
    await reset()
    const codes = (await Promise.all(Array.from({ length: 20 }, (_, i) => jpost(i + 1)))).map((r) => r.status)
    expect(codes.filter((c) => c === 200)).toHaveLength(6)
    expect(codes.filter((c) => c === 409)).toHaveLength(14)
    expect(await roster()).toHaveLength(6)
  })

  test('8 a mutation evicts the team tag in the serving isolate (preview: same isolate only)', async () => {
    await reset()
    expect((await get('/pokemon/snorlax')).r.headers.get('x-brust-cache')).toBe('MISS')
    expect((await get('/pokemon/snorlax')).r.headers.get('x-brust-cache')).toBe('HIT')
    expect((await jpost(143)).status).toBe(200)
    const b = await get('/pokemon/snorlax')
    expect(b.r.headers.get('x-brust-cache')).toBe('MISS')
    expect(storeTags(b.html).find((t) => t.name === 'team')!.json).toMatchObject({ max: 6, members: [{ id: 143 }] })
    expect(b.html).toMatch(/data-testid="add-to-team"[^>]*>In your team</)
  })

  test('9 a wrangler restart keeps the team (persisted local D1)', async () => {
    await reset()
    for (const id of [25, 4]) expect((await jpost(id)).status).toBe(200)
    await w.stop()
    w = await startWrangler({ config: CONFIG, state })
    expect(await roster()).toEqual([25, 4])
    expect((await get('/')).html).toMatch(/data-testid="team-count"[^>]*>2</)
  }, 300_000)
})
