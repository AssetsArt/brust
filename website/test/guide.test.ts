// website/test/guide.test.ts — the Guide pages (C1): every route 200 with its title, the demo route (param, 404,
// real cache headers), the tier of every demo, and each live demo driven in Chromium.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { PAGES } from '../lib/nav'

const app = join(import.meta.dir, '..')
const bin = join(app, '../packages/brust/bin/brust')
const out = 'dist-test-guide'
const port = 23000 + Math.floor(Math.random() * 2000)
const base = `http://127.0.0.1:${port}`
const GUIDE = PAGES.filter((p) => p.group === 'Guide' && p.slug !== 'quickstart')
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Browser | undefined
let manifest: { components: Record<string, { tier: string; client: string | null; jobs: { kind: string }[] }> }

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  // the react demos legitimately print warning hook-unsupported; any other warning is a failure
  expect(b.stdout.toString().split('\n').filter((l) => l.startsWith('warning') && !l.startsWith('warning hook-unsupported'))).toEqual([])
  manifest = JSON.parse(readFileSync(join(app, out, 'manifest.json'), 'utf8'))
  server = Bun.spawn([bin, 'start', '--dist-dir', out], {
    cwd: app,
    env: { ...process.env, BRUST_PORT: String(port), BRUST_ADDR: '127.0.0.1', BRUST_WORKERS: '2', BRUST_DIST_DIR: join(app, out) },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/docs`)).ok) break
    } catch {}
    await Bun.sleep(250)
  }
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  await server?.exited
  rmSync(join(app, out), { recursive: true, force: true })
})

function tierOf(file: string) {
  const prefix = `${file[0]!.toLowerCase()}${file.slice(1)}_`
  const hits = Object.entries(manifest.components).filter(([id]) => id.startsWith(prefix))
  expect([file, hits.length]).toEqual([file, 1])
  return hits[0]![1]
}

async function open(path: string, init?: (p: Page) => Promise<void>): Promise<Page> {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await init?.(page)
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  ;(page as Page & { errors: string[] }).errors = errors
  return page
}
const errorsOf = (p: Page) => (p as Page & { errors: string[] }).errors

test('every Guide page is 200 with its title, a live demo frame and no compiler warning besides the react demos', async () => {
  expect(GUIDE.map((p) => p.slug)).toEqual(['introduction', 'installation', 'project-structure', 'routing', 'loaders', 'rendering-tiers', 'caching', 'actions', 'store', 'configuration', 'cli', 'deployment', 'migrating'])
  for (const p of GUIDE) {
    const r = await fetch(`${base}/docs/${p.slug}`)
    expect([p.slug, r.status]).toEqual([p.slug, 200])
    const html = await r.text()
    expect(html).toContain(`<title>${p.title} · brust docs</title>`)
    expect([p.slug, html.includes('class="browser"')]).toEqual([p.slug, true])
  }
}, 60_000)

test('tiers: pages static; demos as the docs text claims', () => {
  for (const name of ['Introduction', 'Installation', 'ProjectStructure', 'Routing', 'Loaders', 'RenderingTiers', 'Caching', 'Actions', 'Store', 'Configuration', 'Cli', 'Deployment', 'Migrating', 'DemoPokemonPage'])
    expect([name, tierOf(name).tier, tierOf(name).client]).toEqual([name, 'static', null])
  for (const name of ['CacheProbe', 'StarterPicker', 'FileTree', 'RouteMatcher', 'ConfigBuilder', 'SwitchPanels', 'TeamPicker', 'TeamBadge'])
    expect([name, tierOf(name).tier]).toEqual([name, 'native'])
  expect(tierOf('TeamIsland').tier).toBe('react')
})

test('demo route: param, notFound 404, and real MISS / HIT / BYPASS headers', async () => {
  const v = `t${Date.now()}`
  const a = await fetch(`${base}/demo/pokemon/eevee?v=${v}`)
  expect(a.status).toBe(200)
  expect(await a.text()).toContain('<h4>Eevee</h4>')
  expect(a.headers.get('x-brust-cache')).toBe('MISS')
  expect((await fetch(`${base}/demo/pokemon/eevee?v=${v}`)).headers.get('x-brust-cache')).toBe('HIT')
  expect((await fetch(`${base}/demo/pokemon/eevee?v=${v}&nocache=1`)).headers.get('x-brust-cache')).toBe('BYPASS')
  expect((await fetch(`${base}/demo/pokemon/agumon`)).status).toBe(404)
})

test('Loaders: the page loader reads ?pokemon=', async () => {
  expect(await (await fetch(`${base}/docs/loaders?pokemon=snorlax`)).text()).toContain('<h4>Snorlax</h4>')
  expect(await (await fetch(`${base}/docs/loaders?pokemon=agumon`)).text()).toContain('Not in this demo set')
})

test('Rendering tiers: the labels come from the manifest', async () => {
  const html = await (await fetch(`${base}/docs/rendering-tiers`)).text()
  expect(html).toContain('tier static · client none')
  expect(html).toMatch(/tier native · client client\/catchCard_/)
  expect(html).toMatch(/tier react · client client\/react-pokemonSearch_/)
})

test('Routing: the matcher finds the route and decodes params', async () => {
  const page = await open('/docs/routing')
  const input = page.locator('#rm-path')
  const dd = page.locator('.matcher dd')
  await input.fill('/pokemon/mr%2Fmime')
  expect(await dd.allTextContents()).toEqual(['/pokemon/{name}', 'name = "mr/mime"', '200'])
  await input.fill('/pokedex')
  expect(await dd.allTextContents()).toEqual(['/pokedex', 'none', '200'])
  await input.fill('/nope/x')
  expect(await dd.allTextContents()).toEqual(['*', 'none', '404'])
  expect(errorsOf(page)).toEqual([])
  await page.context().close()
}, 60_000)

test('Caching: the probe shows the real headers MISS, HIT, BYPASS', async () => {
  const page = await open('/docs/caching')
  await page.locator('.probe button').click()
  await page.locator('.probe li code').nth(2).waitFor()
  const rows = await page.locator('.probe li code').allTextContents()
  expect(rows.map((r) => r.split(' · ')[1])).toEqual(['x-brust-cache: MISS', 'x-brust-cache: HIT', 'x-brust-cache: BYPASS'])
  expect(errorsOf(page)).toEqual([])
  await page.context().close()
}, 60_000)

test('Actions + Store: real actions, a 409 at the seventh, one store across native and react', async () => {
  const page = await open('/docs/actions')
  const buttons = page.locator('.picker .demo-btn')
  for (let i = 0; i < 6; i++) {
    await buttons.nth(i).click()
    await page.locator('.picker .vp-note', { hasText: `team ${i + 1} / 6` }).waitFor()
  }
  await buttons.nth(6).click()
  await page.locator('.picker .vp-note', { hasText: '409' }).waitFor()
  const ctx = page.context()
  expect((await ctx.cookies()).find((c) => c.name === 'brust_docs_team')?.value.split('.').length).toBe(6)
  // the Store page paints the same team from the cookie on the server, then the island and the badge share the store
  await page.goto(`${base}/docs/store`, { waitUntil: 'networkidle' })
  expect(await page.locator('.team-badge b').textContent()).toBe('6')
  await page.locator('.team-island .demo-list button').first().click()
  await page.locator('.team-badge b', { hasText: '5' }).waitFor()
  expect(await page.locator('.team-island .demo-list li').count()).toBe(5)
  expect(errorsOf(page)).toEqual([])
  await ctx.close()
}, 60_000)

test('Installation, Project structure, Configuration, CLI, Deployment, Migrating: the native demos respond', async () => {
  let page = await open('/docs/installation')
  await page.locator('.starter .choice', { hasText: 'Squirtle' }).click()
  await page.locator('.starter .choice', { hasText: 'pokedex' }).click()
  expect(await page.locator('.starter .cmd').textContent()).toContain('bun create @brust/app@latest squirtle-dex --template pokedex')
  await page.context().close()

  page = await open('/docs/project-structure')
  await page.locator('.tree-list button', { hasText: 'actions.ts' }).click()
  expect(await page.locator('.tree-role p:not([hidden])').textContent()).toContain('Never call app.listen()')
  await page.context().close()

  page = await open('/docs/configuration')
  await page.locator('.fields input').first().fill('8080')
  await page.locator('.fields label.sw').click()
  const toml = await page.locator('.builder .cmd').first().textContent()
  expect(toml).toContain('port = 8080')
  expect(toml).not.toContain('[actions]')
  expect(await page.locator('.builder .cmd').nth(1).textContent()).toContain('BRUST_PORT=8080')
  await page.context().close()

  for (const [path, tab, text] of [
    ['/docs/cli', 'brust dev', 'only --target cloudflare'],
    ['/docs/deployment', 'Cloudflare Workers', 'wrangler deploy'],
    ['/docs/migrating', '2.x', "from '@brust/core/routes'"],
  ] as const) {
    page = await open(path)
    await page.locator('.switch [role=tab]', { hasText: tab }).click()
    expect([path, await page.locator('.switch [role=tabpanel]:not([hidden]) code').textContent()]).toEqual([path, expect.stringContaining(text)])
    expect(errorsOf(page)).toEqual([])
    await page.context().close()
  }
}, 120_000)
