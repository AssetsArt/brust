// website/test/guide.test.ts — the Guide pages (C1): every route 200 with its title, the demo route (param, 404,
// real cache headers), the tier of every demo, and each live demo driven in Chromium.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type Browser, chromium, type Page } from 'playwright'
import { PAGES } from '../lib/nav'
import { build, component, freshOut, HOOK_MS, type Manifest, ready, serve, type Server, TEST_MS, until, WAIT_MS } from './harness'

const GUIDE = PAGES.filter((p) => (p.group === 'Guide' || p.group === 'React & libraries') && p.slug !== 'quickstart')
let base = ''
let srv: Server | undefined
let browser: Browser | undefined
let manifest: Manifest

beforeAll(async () => {
  const out = freshOut('guide')
  // the react demos legitimately print warning hook-unsupported; any other warning is a failure
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('guide')
}, HOOK_MS)

const tierOf = (file: string) => component(manifest, file)

async function open(path: string): Promise<Page> {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
  ctx.setDefaultTimeout(WAIT_MS)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  ;(page as Page & { errors: string[] }).errors = errors
  return page
}
const errorsOf = (p: Page) => (p as Page & { errors: string[] }).errors

test('every Guide page is 200 with its title, a live demo frame and no compiler warning besides the react demos', async () => {
  expect(GUIDE.map((p) => p.slug)).toEqual(['introduction', 'installation', 'release-notes', 'project-structure', 'routing', 'loaders', 'rendering-tiers', 'caching', 'actions', 'store', 'css', 'configuration', 'cli', 'dev-mode', 'deployment', 'migrating', 'react-coverage', 'packages', 'shadcn', 'guides/shadcn-setup'])
  for (const p of GUIDE) {
    const r = await fetch(`${base}/docs/${p.slug}`)
    expect([p.slug, r.status]).toEqual([p.slug, 200])
    const html = await r.text()
    expect(html).toContain(`<title>${p.title} · brust docs</title>`)
    // the coverage pages are reference tables generated from docs/*-coverage.json , the release notes and the shadcn setup guide are prose (its steps run in the reader's terminal): no demo frame
    expect([p.slug, ['react-coverage', 'shadcn', 'release-notes', 'guides/shadcn-setup'].includes(p.slug) || /class="browser[ "]/.test(html)]).toEqual([p.slug, true])
  }
}, TEST_MS)

test('tiers: pages static; demos as the docs text claims', () => {
  for (const name of ['Introduction', 'Installation', 'ProjectStructure', 'Routing', 'Loaders', 'RenderingTiers', 'Caching', 'Actions', 'Store', 'Configuration', 'Cli', 'Deployment', 'Migrating', 'DemoPokemonPage'])
    expect([name, tierOf(name).tier, tierOf(name).client]).toEqual([name, 'static', null])
  for (const name of ['CacheProbe', 'StarterPicker', 'FileTree', 'RouteMatcher', 'ConfigBuilder', 'SwitchPanels', 'TeamPicker', 'TeamBadge', 'LoaderDemo'])
    expect([name, tierOf(name).tier]).toEqual([name, 'native'])
  expect(tierOf('TeamIsland').tier).toBe('react')
})

test('demo route: param, notFound 404, and real MISS / HIT / BYPASS headers', async () => {
  const v = `t${Date.now()}`
  const a = await fetch(`${base}/demo/pokemon/eevee?v=${v}`)
  expect(a.status).toBe(200)
  expect(await a.text()).toMatch(/<h4[^>]*>Eevee<\/h4>/)
  expect(a.headers.get('x-brust-cache')).toBe('MISS')
  expect((await fetch(`${base}/demo/pokemon/eevee?v=${v}`)).headers.get('x-brust-cache')).toBe('HIT')
  expect((await fetch(`${base}/demo/pokemon/eevee?v=${v}&nocache=1`)).headers.get('x-brust-cache')).toBe('BYPASS')
  expect((await fetch(`${base}/demo/pokemon/agumon`)).status).toBe(404)
})

test('Loaders: the page is painted with pikachu whatever the query (static export), the browser reads ?pokemon=', async () => {
  for (const q of ['', '?pokemon=snorlax']) expect(await (await fetch(`${base}/docs/loaders${q}`)).text()).toMatch(/<h4[^>]*>Pikachu<\/h4>/)
  const page = await open('/docs/loaders?pokemon=snorlax')
  await ready(page, '.loader-demo')
  await page.locator('.loader-demo h4', { hasText: 'Snorlax' }).waitFor()
  await page.locator('.loader-demo button', { hasText: 'agumon' }).click()
  await page.locator('.loader-demo .vp-note', { hasText: 'Not in this demo set' }).waitFor()
  expect(new URL(page.url()).search).toBe('?pokemon=agumon')
  expect(errorsOf(page)).toEqual([])
  await page.context().close()
}, TEST_MS)

test('no server features: no actions app, no /_brust/action, no cookie', async () => {
  expect((manifest as Manifest & { actions: unknown }).actions).toBeNull()
  expect((await fetch(`${base}/_brust/action/team`)).status).toBe(404)
  for (const p of ['/docs/actions', '/docs/store']) expect([p, (await fetch(`${base}${p}`)).headers.get('set-cookie')]).toEqual([p, null])
})

test('Rendering tiers: the labels come from the manifest', async () => {
  const html = await (await fetch(`${base}/docs/rendering-tiers`)).text()
  expect(html).toContain('tier static · client none')
  expect(html).toMatch(/tier native · client client\/catchCard_/)
  expect(html).toMatch(/tier react · client client\/react-pokemonSearch_/)
})

test('Routing: the matcher finds the route and decodes params', async () => {
  const page = await open('/docs/routing')
  await ready(page, '.matcher')
  const input = page.locator('#rm-path')
  const dd = () => page.locator('.matcher dd').allTextContents()
  for (const [path, want] of [
    ['/pokemon/mr%2Fmime', ['/pokemon/{name}', 'name = "mr/mime"', '200']],
    ['/pokedex', ['/pokedex', 'none', '200']],
    ['/nope/x', ['*', 'none', '404']],
  ] as const) {
    await input.fill(path)
    expect(await until(dd, (v) => v.join('|') === want.join('|'))).toEqual([...want])
  }
  expect(errorsOf(page)).toEqual([])
  await page.context().close()
}, TEST_MS)

test('Caching: the simulated probe shows MISS, HIT, BYPASS like the real server', async () => {
  const page = await open('/docs/caching')
  await ready(page, '.probe')
  await page.locator('.probe button').click()
  await page.locator('.probe li code').nth(2).waitFor()
  const rows = await page.locator('.probe li code').allTextContents()
  expect(rows.map((r) => r.split(' · ')[1])).toEqual(['x-brust-cache: MISS', 'x-brust-cache: HIT', 'x-brust-cache: BYPASS'])
  expect(errorsOf(page)).toEqual([])
  await page.context().close()
}, TEST_MS)

test('Actions + Store: browser-only team, a TeamFull 409 at the seventh, one store across native and react', async () => {
  const page = await open('/docs/actions')
  await ready(page, '.picker')
  const buttons = page.locator('.picker button')
  for (let i = 0; i < 6; i++) {
    await buttons.nth(i).click()
    await page.locator('.picker .vp-note', { hasText: `team ${i + 1} / 6` }).waitFor()
  }
  await buttons.nth(6).click()
  await page.locator('.picker .vp-note', { hasText: '409 TeamFull' }).waitFor()
  const ctx = page.context()
  expect(await ctx.cookies()).toEqual([])
  expect(await page.evaluate(() => localStorage.getItem('brust_docs_team')?.split('.').length)).toBe(6)
  // the Store page is painted with an empty team, then the browser fills the badge and the island from storage
  await page.goto(`${base}/docs/store`, { waitUntil: 'networkidle' })
  await ready(page, '.team-badge')
  await page.locator('.team-badge b', { hasText: '6' }).waitFor()
  await page.locator('brust-island[data-hydrated] .team-island').waitFor()
  await page.locator('.team-island ul button').first().click()
  await page.locator('.team-badge b', { hasText: '5' }).waitFor()
  expect(await until(() => page.locator('.team-island ul li').count(), (n) => n === 5)).toBe(5)
  expect(errorsOf(page)).toEqual([])
  await ctx.close()
}, TEST_MS)

test('Installation, Project structure, Configuration, CLI, Deployment, Migrating: the native demos respond', async () => {
  let page = await open('/docs/installation')
  await ready(page, '.starter')
  await page.locator('.starter .choice', { hasText: 'Squirtle' }).click()
  await page.locator('.starter .choice', { hasText: 'pokedex' }).click()
  const want = 'bun create @brust/app@latest squirtle-dex --template pokedex'
  expect(await until(() => page.locator('.starter .cmd').textContent(), (t) => !!t?.includes(want))).toContain(want)
  await page.context().close()

  page = await open('/docs/project-structure')
  await ready(page, '.tree')
  await page.locator('.tree-list button', { hasText: 'actions.ts' }).click()
  const role = () => page.locator('.tree-role p:not([hidden])').textContent()
  expect(await until(role, (t) => !!t?.includes('Never call app.listen()'))).toContain('Never call app.listen()')
  await page.context().close()

  page = await open('/docs/configuration')
  await ready(page, '.builder')
  await page.locator('.fields input').first().fill('8080')
  await page.locator('.fields label:has(input[type=checkbox])').click()
  const toml = await until(() => page.locator('.builder .cmd').first().textContent(), (t) => !!t?.includes('port = 8080') && !t.includes('[actions]'))
  expect(toml).toContain('port = 8080')
  expect(toml).not.toContain('[actions]')
  expect(await page.locator('.builder .cmd').nth(1).textContent()).toContain('BRUST_PORT=8080')
  await page.context().close()

  for (const [path, tab, text] of [
    ['/docs/cli', 'brust dev', 'css public/app.css (no reload)'],
    ['/docs/deployment', 'Cloudflare Workers', 'wrangler deploy'],
    ['/docs/migrating', '2.x', "from '@brust/core/routes'"],
  ] as const) {
    page = await open(path)
    await ready(page, '.switch')
    await page.locator('.switch [role=tab]', { hasText: tab }).click()
    const shown = () => page.locator('.switch [role=tabpanel]:not([hidden]) code').textContent()
    expect([path, await until(shown, (t) => !!t?.includes(text))]).toEqual([path, expect.stringContaining(text)])
    expect(errorsOf(page)).toEqual([])
    await page.context().close()
  }
}, TEST_MS)
