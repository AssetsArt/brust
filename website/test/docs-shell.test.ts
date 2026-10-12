// website/test/docs-shell.test.ts — the docs shell: one route per nav entry, the shell's tiers, and in Chromium the
// sidebar/pager/edit link, the "On this page" scrollspy and the Copy button (no Clipboard API; timer restart).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { DOCS_HOME, NAV, PAGES } from '../lib/nav'

const app = join(import.meta.dir, '..')
const coreVersion = JSON.parse(readFileSync(join(app, '../packages/brust/package.json'), 'utf8')).version as string
const bin = join(app, '../packages/brust/bin/brust')
const out = 'dist-test-shell'
const port = 21000 + Math.floor(Math.random() * 2000)
const base = `http://127.0.0.1:${port}`
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Browser | undefined

interface Manifest {
  routes: { pattern: string }[]
  components: Record<string, { tier: string; client: string | null; jobs: { kind: string }[] }>
}
let manifest: Manifest

function component(name: string) {
  const prefix = `${name[0]!.toLowerCase()}${name.slice(1)}_`
  const hits = Object.entries(manifest.components).filter(([id]) => id.startsWith(prefix))
  expect([name, hits.length]).toEqual([name, 1])
  return hits[0]![1]
}

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.stdout.toString()).not.toContain('warning')
  expect(b.exitCode).toBe(0)
  manifest = JSON.parse(readFileSync(join(app, out, 'manifest.json'), 'utf8'))
  server = Bun.spawn([bin, 'start', '--dist-dir', out], {
    cwd: app,
    env: { ...process.env, BRUST_PORT: String(port), BRUST_ADDR: '127.0.0.1', BRUST_WORKERS: '2' },
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

test('routes: /docs plus one /docs/{slug} per nav entry, in nav order; the canon slugs are present', () => {
  const patterns = manifest.routes.map((r) => r.pattern)
  expect(patterns).toEqual(['/', '/docs', ...PAGES.map((p) => `/docs/${p.slug}`), '*'])
  expect(NAV.map((g) => [g.group, g.items.length])).toEqual([
    ['Guide', 14],
    ['Cloudflare', 3],
    ['Cache adapters', 4],
    ['Cookbook', 5],
  ])
  for (const s of ['quickstart', 'routing', 'rendering-tiers', 'cookbook/hello-world']) expect(patterns).toContain(`/docs/${s}`)
})

test('tiers: the shell and Quickstart are static with no jobs; Toc and CopyButton are native', () => {
  for (const name of ['DocsLayout', 'Step', 'Note', 'Quickstart', 'Introduction']) {
    const c = component(name)
    expect([name, c.tier, c.jobs.length, c.client]).toEqual([name, 'static', 0, null])
  }
  for (const name of ['Toc', 'CopyButton']) expect([name, component(name).tier]).toEqual([name, 'native'])
})

test('every docs route is 200 with its title and current sidebar link; /docs is the docs home; unknown docs path 404', async () => {
  for (const p of PAGES) {
    const r = await fetch(`${base}/docs/${p.slug}`)
    expect([p.slug, r.status]).toEqual([p.slug, 200])
    const html = await r.text()
    expect(html).toContain(`<title>${p.title} · brust docs</title>`)
    // page loader keys merge over the layouts': the header version must survive every page
    expect(html).toContain(`<span class="v">${coreVersion}</span>`)
    expect(html).toContain(`<a href="/docs/${p.slug}" aria-current="page">${p.title}</a>`)
    expect(html).toContain(`<div class="crumbs">${p.group} / ${p.title}</div>`)
    expect(html).toContain(`https://github.com/AssetsArt/brust/blob/v2/website/${p.file}`)
  }
  const home = PAGES.find((p) => p.slug === DOCS_HOME)!
  const docs = await (await fetch(`${base}/docs`)).text()
  expect(docs).toContain(`<a href="/docs/${home.slug}" aria-current="page">${home.title}</a>`)
  expect((await fetch(`${base}/docs/nope`)).status).toBe(404)
}, 60_000)

test('pager: previous/next follow the nav order across groups; the ends have one side', async () => {
  const first = await (await fetch(`${base}/docs/introduction`)).text()
  expect(first).not.toContain('<span>Previous</span>')
  expect(first).toContain('<a class="next" href="/docs/installation"><span>Next</span><b>Installation</b></a>')
  const qs = await (await fetch(`${base}/docs/quickstart`)).text()
  expect(qs).toContain('<a href="/docs/installation"><span>Previous</span><b>Installation</b></a>')
  expect(qs).toContain('<a class="next" href="/docs/project-structure"><span>Next</span><b>Project structure</b></a>')
  const cross = await (await fetch(`${base}/docs/migrating`)).text()
  expect(cross).toContain('<a class="next" href="/docs/cloudflare/workers"><span>Next</span><b>Workers target</b></a>')
  const last = await (await fetch(`${base}/docs/cookbook/invalidate-the-cache`)).text()
  expect(last).not.toContain('<span>Next</span>')
})

test('On this page: the section being read is aria-current and the dot moves to it', async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
  await page.goto(`${base}/docs/quickstart`, { waitUntil: 'networkidle' })
  const current = () => page.locator('.toc a[aria-current="location"]').allTextContents()
  expect(await current()).toEqual(['Check the requirements'])
  await page.locator('#run').scrollIntoViewIfNeeded()
  await page.evaluate(() => scrollTo(0, document.getElementById('run')!.offsetTop - 40))
  await page.waitForTimeout(100)
  expect(await current()).toEqual(['Run it'])
  const y = await page.evaluate(() => getComputedStyle(document.querySelector('.toc')!).getPropertyValue('--ind-y'))
  expect(Number.parseFloat(y)).toBeGreaterThan(0)
  await page.close()
}, 60_000)

test('CopyButton without the Clipboard API: says "Select to copy" and selects the code', async () => {
  const ctx = await browser!.newContext()
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined }))
  const page = await ctx.newPage()
  await page.goto(`${base}/docs/quickstart`, { waitUntil: 'networkidle' })
  const btn = page.locator('figure.code button').first()
  await btn.click()
  expect(await btn.textContent()).toBe('Select to copy')
  expect(await page.evaluate(() => String(getSelection()))).toContain('bun --version')
  await ctx.close()
}, 60_000)

test('CopyButton: a second click restarts the 1.4 s reset (the first timer is cleared)', async () => {
  const ctx = await browser!.newContext()
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  const page = await ctx.newPage()
  await page.clock.install()
  await page.goto(`${base}/docs/quickstart`, { waitUntil: 'networkidle' })
  const btn = page.locator('figure.code button').nth(1)
  await btn.click()
  await page.locator('figure.code button.done').waitFor()
  expect(await btn.textContent()).toBe('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('bun create @brust/app@latest my-app\ncd my-app && bun install')
  await page.clock.runFor(1000)
  await btn.click()
  await Bun.sleep(150) // real time: let the clipboard promise settle and arm the new timer
  await page.clock.runFor(1000) // 2.0 s after the first click: the first timer would have reset the label at 1.4 s
  expect(await btn.textContent()).toBe('Copied')
  await page.clock.runFor(500) // 1.5 s after the second click
  expect(await btn.textContent()).toBe('Copy')
  await ctx.close()
}, 60_000)
