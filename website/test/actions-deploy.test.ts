// website/test/actions-deploy.test.ts — /docs/actions and /docs/deployment (docs-actions-deploy): the new sections and their
// anchors, the cross-origin rules (unit, then driven in Chromium), the "Static files" tab, the tiers of the new pieces,
// and every `source:` citation on the two pages resolving to a real file and line.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { type CrossOriginInput, checkCrossOrigin } from '../components/demos/cross-origin'
import { build, component, freshOut, HOOK_MS, type Manifest, ready, serve, type Server, TEST_MS, until, WAIT_MS } from './harness'

let base = ''
let srv: Server | undefined
let browser: Browser | undefined
let manifest: Manifest
let actions = ''
let deployment = ''

beforeAll(async () => {
  const out = freshOut('actions-deploy')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  actions = await (await fetch(`${base}/docs/actions`)).text()
  deployment = await (await fetch(`${base}/docs/deployment`)).text()
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('actions-deploy')
}, HOOK_MS)

async function open(path: string): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
  ctx.setDefaultTimeout(WAIT_MS)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  return { page, errors }
}

test('Actions: the separate-deployment and cross-origin sections, their anchors and the key settings', () => {
  for (const id of ['separate', 'actions-only', 'base-url', 'cross-origin', 'try', 'errors']) expect([id, actions.includes(`id="${id}"`)]).toEqual([id, true])
  for (const s of ['href="#separate"', 'href="#cross-origin"', 'brust build --actions-only', 'BRUST_ACTIONS_BASE_URL', '__BRUST_ACTION_BASE__', 'CrossSiteRejected', 'SameSite=None; Secure', 'A page-only build'])
    expect([s, actions.includes(s)]).toEqual([s, true])
  // the existing team demo is kept
  expect(actions).toContain('TeamPicker')
})

test('Deployment: static files, Pages + actions, and the Workers section', () => {
  for (const id of ['pick', 'bun', 'static', 'pages-actions', 'workers']) expect([id, deployment.includes(`id="${id}"`)]).toEqual([id, true])
  for (const s of ['--target static', 'ssg-params-missing', '404.html', '_routes.json', '.assetsignore', 'ssg-actions-cache', 'wrangler pages deploy', 'href="/docs/actions#separate"'])
    expect([s, deployment.includes(s)]).toEqual([s, true])
})

test('tiers: the cross-origin check is a React island, the pages stay static', () => {
  expect(component(manifest, 'CrossOriginCheck').tier).toBe('react')
  expect(component(manifest, 'Actions').tier).toBe('static')
  expect(component(manifest, 'Deployment').tier).toBe('static')
})

const BASE: CrossOriginInput = {
  page: 'https://app.example.com',
  actions: 'https://api.example.com',
  corsOrigins: 'https://app.example.com',
  corsCredentials: true,
  credentials: 'include',
  method: 'POST',
  crossSite: 'reject',
}

test('the cross-origin rules mirror the server: preflight, guard, credentials, boot error', () => {
  const run = (o: Partial<CrossOriginInput>) => checkCrossOrigin({ ...BASE, ...o }).outcome
  expect(run({})).toBe('ok')
  expect(run({ actions: 'https://app.example.com' })).toBe('ok') // same origin
  expect(run({ corsOrigins: '' })).toBe('blocked') // no [cors]: no CORS headers on the preflight
  expect(run({ corsOrigins: 'https://other.example.com' })).toBe('blocked')
  expect(run({ corsOrigins: '*', corsCredentials: true })).toBe('boot-error')
  expect(run({ corsOrigins: '*', corsCredentials: false, credentials: 'omit' })).toBe('rejected') // a wildcard never passes the guard
  expect(run({ corsOrigins: '*', corsCredentials: false, credentials: 'omit', method: 'GET' })).toBe('ok')
  expect(run({ corsOrigins: '*', corsCredentials: false, credentials: 'omit', crossSite: 'allow' })).toBe('ok')
  expect(run({ corsCredentials: false })).toBe('blocked') // credentials: include needs [cors] credentials = true
  expect(run({ corsCredentials: false, credentials: 'same-origin' })).toBe('ok')
  expect(run({ actions: 'https://api.example.com/v1' })).toBe('invalid')
})

test('the cross-origin check (Chromium): hydrates, the default reaches the app, a wildcard is a 403, no [cors] is blocked', async () => {
  const { page, errors } = await open('/docs/actions')
  const box = page.getByTestId('cross-origin')
  await box.scrollIntoViewIfNeeded()
  await page.locator('brust-island[data-hydrated="1"]:has([data-testid="cross-origin"])').waitFor({ state: 'attached', timeout: WAIT_MS })
  const out = box.locator('pre.cmd')
  expect(await out.getAttribute('data-outcome')).toBe('ok')
  expect(await out.innerText()).toContain('=> reaches your app')
  await box.locator('label:has(input[type=checkbox])').click()
  expect(await box.getByLabel('[cors] credentials = true').isChecked()).toBe(false)
  await box.getByLabel('[actions] credentials').selectOption('omit')
  await box.getByLabel('[cors] origins (api/brust.toml)').fill('*')
  expect(await until(() => out.innerText(), (t) => t.includes('403 CrossSiteRejected'))).toContain('a wildcard in [cors] does not count')
  await box.getByLabel('[cors] origins (api/brust.toml)').fill('')
  expect(await until(() => out.innerText(), (t) => t.includes('blocked by the browser'))).toContain('no [cors] on the actions server')
  expect(errors).toEqual([])
  await page.context().close()
}, TEST_MS)

test('Deployment (Chromium): the "Static files" tab shows the static build', async () => {
  const { page, errors } = await open('/docs/deployment')
  await ready(page, '.switch')
  await page.locator('.switch [role=tab]', { hasText: 'Static files' }).click()
  const shown = () => page.locator('.switch [role=tabpanel]:not([hidden]) code').textContent()
  expect(await until(shown, (t) => !!t?.includes('--target static'))).toContain('wrangler pages deploy dist/static')
  expect(errors).toEqual([])
  await page.context().close()
}, TEST_MS)

test('every cited source line exists (pages and the cross-origin rules)', () => {
  const root = join(import.meta.dir, '..', '..')
  let cites = 0
  for (const rel of ['pages/docs/Actions.tsx', 'pages/docs/Deployment.tsx', 'components/demos/cross-origin.ts']) {
    const src = readFileSync(join(import.meta.dir, '..', rel), 'utf8')
    for (const line of src.split('\n').filter((l) => /source:/.test(l))) {
      let file = ''
      // a bare `name.ext:12` after a full path means the file in the same directory as that path
      for (const m of line.matchAll(/((?:crates|packages|docs)\/[\w./-]+\.\w+)|(?<![\w/.])([\w-]+\.(?:rs|ts|md))(?=:\d)|:(\d+)(?:-(\d+))?/g)) {
        if (m[1]) file = m[1]
        else if (m[2]) file = file ? join(file, '..', m[2]) : ''
        else if (m[3] && file) {
          expect([rel, file, existsSync(join(root, file))]).toEqual([rel, file, true])
          const n = readFileSync(join(root, file), 'utf8').split('\n').length
          expect([rel, file, m[0], Number(m[4] ?? m[3]) <= n]).toEqual([rel, file, m[0], true])
          cites++
        }
      }
      // every `docs/x.md §N` names a section that exists
      for (const m of line.matchAll(/(docs\/[\w-]+\.md) §(\d+)/g)) {
        const md = readFileSync(join(root, m[1]!), 'utf8')
        expect([m[0], new RegExp(`^## ${m[2]}\\.`, 'm').test(md)]).toEqual([m[0], true])
      }
    }
  }
  expect(cites).toBeGreaterThanOrEqual(40)
})
