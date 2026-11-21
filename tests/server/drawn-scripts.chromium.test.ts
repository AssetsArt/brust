// F591: a response carries the chunk of a native component only when it printed one of that component's hosts
// (`[build] component_scripts = "drawn"`, the default). Each case asserts the exact module-script list of the served
// document, then clicks in real Chromium that every host the page has, or can draw on the client, works. The fixture is
// also built with `component_scripts = "route"` (case 10): every chunk the route can print, as before.
// Run alone: `bun test --timeout 180000 tests/server/drawn-scripts.chromium.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'

const fixtures = join(import.meta.dir, '../../packages/brust/test/fixtures')
const app = join(fixtures, 'drawn-scripts')
const routeApp = join(fixtures, '.drawn-scripts-route')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')

interface Server {
  proc: ReturnType<typeof Bun.spawn>
  base: string
  /** module-script file (`client/<id>-<hex>.js`) → the name it is asserted by (`runtime`, `rt-if`, a component id). */
  names: Map<string, string>
  manifest: { components: Record<string, { client: string | null; children: { id: string }[] }>; assets: { runtime: string; nav: string; features: Record<string, string>; react?: string } }
}

async function serve(dir: string): Promise<Server> {
  rmSync(join(dir, 'dist'), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const manifest = JSON.parse(readFileSync(join(dir, 'dist', 'manifest.json'), 'utf8')) as Server['manifest']
  const names = new Map<string, string>([
    [manifest.assets.runtime, 'runtime'],
    [manifest.assets.nav, 'nav'],
  ])
  for (const [k, f] of Object.entries(manifest.assets.features)) names.set(f, `rt-${k}`)
  if (manifest.assets.react) names.set(manifest.assets.react, 'react')
  for (const [id, c] of Object.entries(manifest.components)) if (c.client) names.set(c.client, id)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: dir, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  return { proc, base: `http://${/listening on (\S+)/.exec(out)![1]}`, names, manifest }
}

async function stop(s: Server | undefined) {
  if (!s) return
  s.proc.kill('SIGINT')
  if ((await Promise.race([s.proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    s.proc.kill('SIGKILL')
    await s.proc.exited
  }
}

let drawn: Server
let route: Server
let browser: Browser | undefined

beforeAll(async () => {
  rmSync(routeApp, { recursive: true, force: true })
  cpSync(app, routeApp, { recursive: true, filter: (f) => !f.includes(`${app}/dist`) && !f.includes(`${app}/.brust`) })
  writeFileSync(join(routeApp, 'brust.toml'), '[actions]\n\n[build]\ncomponent_scripts = "route"\n')
  ;[drawn, route] = await Promise.all([serve(app), serve(routeApp)])
}, 240_000)

afterAll(async () => {
  await browser?.close()
  await Promise.all([stop(drawn), stop(route)])
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  rmSync(routeApp, { recursive: true, force: true })
})

/** The browser starts with the first click test, so the list assertions run where no browser is installed. */
async function page(): Promise<Page> {
  if (!browser) {
    const { chromium } = await import('playwright')
    browser = await chromium.launch()
  }
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(String(e)))
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  ;(p as Page & { errors: string[] }).errors = errors
  return p
}

/** The id of the component whose name starts `<name>_` (the build appends a hash of its file). */
const id = (s: Server, name: string) => {
  const ids = Object.keys(s.manifest.components).filter((k) => k.startsWith(`${name}_`) && !/_h[0-9a-f]{8}$/.test(k))
  if (ids.length !== 1) throw new Error(`no single component named ${name}: ${ids.join(', ')}`)
  return ids[0]!
}
/** The host-specialised copy of `box` that `site` places: the page links each site's copy right after the site. */
const boxOf = (s: Server, site: string) => {
  const kids = s.manifest.components[id(s, 'p11')]!.children.map((c) => c.id)
  return kids.slice(kids.indexOf(id(s, site))).find((c) => c.startsWith(`${id(s, 'box')}_h`))!
}

/** Every module script of the document, in order, by name. */
function scripts(s: Server, html: string): string[] {
  return [...html.matchAll(/<script type="module" src="[^"]*\/_brust\/(client\/[^"]+)"/g)].map((m) => s.names.get(m[1]!) ?? m[1]!)
}

async function get(s: Server, path: string) {
  const r = await fetch(s.base + path)
  return { status: r.status, html: await r.text(), cache: r.headers.get('x-brust-cache') }
}

/** The names a list is asserted by: plain strings stay, `@w1` is the id of component `w1`. */
const names = (s: Server, xs: string[]) => xs.map((x) => (x.startsWith('@') ? id(s, x.slice(1)) : x))
const CORE = ['nav', 'runtime', 'rt-basics']

/** The cases' lists on `drawn`: what each response printed. */
const DRAWN: Record<string, (s: Server) => string[]> = {
  '/1/none': (s) => names(s, [...CORE, '@always']),
  '/1/w1': (s) => names(s, [...CORE, '@always', '@w1']),
  '/1/all': (s) => names(s, [...CORE, '@always', '@w1', '@w2', '@w3', '@w4', '@w5', '@w6']),
  '/1/fake': (s) => names(s, [...CORE, '@always']),
  '/2': (s) => names(s, [...CORE, 'rt-if', '@toggle', '@w1']),
  '/3': (s) => names(s, [...CORE, 'rt-if', '@outer', '@inner', '@w2']),
  '/4/empty': (s) => names(s, [...CORE, 'rt-for', '@board', '@card', '@motion']),
  '/4/full': (s) => names(s, [...CORE, 'rt-for', '@board', '@card', '@motion']),
  '/5': (s) => names(s, [...CORE, 'rt-if', '@nest', '@mid', '@leaf']),
  '/6': (s) => names(s, [...CORE, 'rt-island', '@frame']),
  '/9/none': (s) => names(s, [...CORE, '@lw']),
  '/9/w4': (s) => names(s, [...CORE, '@lw', '@w4']),
  '/9/gone': (s) => names(s, [...CORE, '@lw']),
  '/9/deny': (s) => names(s, [...CORE, '@lw']),
  '/11/a': (s) => [...names(s, [...CORE, '@siteA']), boxOf(s, 'siteA')],
  '/11/b': (s) => [...names(s, [...CORE, '@siteB']), boxOf(s, 'siteB')],
  '/11/ab': (s) => [...names(s, [...CORE, '@siteA']), boxOf(s, 'siteA'), id(s, 'siteB'), boxOf(s, 'siteB')],
  // Case 13: a chunk bundling load-time code (busy: a global write; caller: an app call at load) is carried whatever the
  // page printed; tidy bundles only a module that runs nothing at load.
  '/13/none': (s) => names(s, [...CORE, '@busy', '@caller']),
  '/13/tidy': (s) => names(s, [...CORE, '@busy', '@tidy', '@caller']),
  // F597: forms bundles a module of every accepted load-time form: left out above, carried where it is drawn.
  '/13/forms': (s) => names(s, [...CORE, '@busy', '@caller', '@forms']),
  '/12': (s) => names(s, CORE),
  '/12?raw=1': (s) => names(s, [...CORE, '@w5']),
}

describe('the list each response carries (drawn)', () => {
  for (const [path, want] of Object.entries(DRAWN))
    test(path, async () => {
      const r = await get(drawn, path)
      expect(r.status).toBe(path === '/9/gone' ? 404 : path === '/9/deny' ? 403 : 200)
      expect(scripts(drawn, r.html)).toEqual(want(drawn))
    })

  test('case 1: 4 / 5 / 10 module scripts for none / one / all', async () => {
    const n = async (k: string) => scripts(drawn, (await get(drawn, `/1/${k}`)).html).length
    expect([await n('none'), await n('w1'), await n('all')]).toEqual([4, 5, 10])
  })

  test('case 12: text and an attribute value that spell a host keep nothing (escaped); raw HTML keeps the chunk', async () => {
    const r = await get(drawn, '/1/fake')
    const w5 = id(drawn, 'w5')
    expect(r.html).toContain(`<p id="fake" title="x-data=&quot;${w5}&quot;">x-data=&quot;${w5}&quot;</p>`)
    expect(r.html).not.toContain(`x-data="${w5}"`)
    expect((await get(drawn, '/12?raw=1')).html).toContain(`<button x-data="${w5}">raw</button>`)
  })

  test('N2: every chunk that has hosts registers exactly one behaviour, the one its hosts name', () => {
    const m = drawn.manifest as unknown as { components: Record<string, { client: string | null; hosts?: string[] }> }
    const hosted = Object.entries(m.components).filter(([, c]) => c.hosts)
    expect(hosted.length).toBeGreaterThan(20)
    for (const [cid, c] of hosted) {
      expect(c.hosts).toEqual([cid])
      const js = readFileSync(join(app, 'dist', c.client!), 'utf8')
      // The runtime's `defineBehavior` is imported under a minified name; every call of it registers one behaviour.
      const imp = /import\{([^}]*)\}from"[^"]*runtime-[0-9a-f]+\.js"/.exec(js)?.[1] ?? ''
      const named = /(?:^|,)defineBehavior(?: as ([\w$]+))?(?:,|$)/.exec(imp)
      expect(named, cid).not.toBeNull()
      const alias = (named![1] ?? 'defineBehavior').replace(/\$/g, '\\$')
      const all = [...js.matchAll(new RegExp(`(?<![\\w$.])${alias}\\(`, 'g'))].length
      const calls = [...js.matchAll(new RegExp(`(?<![\\w$.])${alias}\\(("[^"]*")`, 'g'))].map((x) => JSON.parse(x[1]!))
      expect(all, cid).toBe(1)
      expect(calls, cid).toEqual([cid])
    }
  })

  test('case 8: the page cache stores the list it rendered (MISS then HIT, byte-identical), per URL of one route', async () => {
    for (const k of ['none', 'w1']) {
      const a = await get(drawn, `/8/${k}`)
      const b = await get(drawn, `/8/${k}`)
      expect([a.cache, b.cache]).toEqual(['MISS', 'HIT'])
      expect(b.html).toBe(a.html)
    }
    expect(scripts(drawn, (await get(drawn, '/8/none')).html)).toEqual(DRAWN['/1/none']!(drawn))
    expect(scripts(drawn, (await get(drawn, '/8/w1')).html)).toEqual(DRAWN['/1/w1']!(drawn))
  })
})

/** Today's list: the route's chain, the targets of its jobs and its children, in that order, whatever it printed. */
function routeList(s: Server, chain: string[]): string[] {
  const out: string[] = []
  const add = (x: string) => {
    const c = s.manifest.components[x]
    if (c?.client && !out.includes(x)) out.push(x)
  }
  for (const c of chain) {
    add(c)
    for (const ch of s.manifest.components[c]!.children) add(ch.id)
  }
  return out
}

describe('case 10: component_scripts = "route" carries every chunk the route can print', () => {
  const CHAINS: Record<string, string[]> = { '/1/none': ['kinds'], '/1/w1': ['kinds'], '/9/none': ['layout', 'status'], '/11/a': ['p11'] }
  for (const [path, chain] of Object.entries(CHAINS))
    test(path, async () => {
      const r = await get(route, path)
      const listed = scripts(route, r.html).filter((n) => !n.startsWith('rt-') && !['nav', 'runtime', 'react'].includes(n))
      expect(listed).toEqual(routeList(route, chain.map((c) => id(route, c))))
      // Apart from the tags, the two builds serve the same document.
      const strip = (h: string) => h.replace(/<script type="module" src="[^"]*"[^>]*><\/script>/g, '').replace(/ data-brust-build="[^"]*"/, '')
      expect(strip(r.html)).toBe(strip((await get(drawn, path)).html))
    })
  test('/1/none carries all 10 module scripts, as before', async () => {
    expect(scripts(route, (await get(route, '/1/none')).html).length).toBe(10)
  })
})

describe('D5: --target static writes each page with the list it printed', () => {
  const staticApp = join(fixtures, '.drawn-scripts-static')
  afterAll(() => rmSync(staticApp, { recursive: true, force: true }))
  test('every page of routes.static.tsx', () => {
    rmSync(staticApp, { recursive: true, force: true })
    cpSync(app, staticApp, { recursive: true, filter: (f) => !f.includes(`${app}/dist`) && !f.includes(`${app}/.brust`) })
    // No `[actions]`: a static build with actions is a hybrid one (a Worker), which this case does not need.
    rmSync(join(staticApp, 'brust.toml'))
    const out = join(staticApp, 'out')
    const b = Bun.spawnSync([bin, 'build', 'routes.static.tsx', '--target', 'static', '--out-dir', out], { cwd: staticApp, stdout: 'pipe', stderr: 'pipe' })
    if (b.exitCode !== 0) throw new Error(`brust build --target static failed:\n${b.stderr.toString()}`)
    const pages: Record<string, string> = { '1/none.html': '/1/none', '1/w1.html': '/1/w1', '1/all.html': '/1/all', '2.html': '/2', '5.html': '/5' }
    for (const [file, path] of Object.entries(pages)) {
      // The static build's component ids and chunk names are the served build's: the same sources, the same hashes.
      expect(scripts(drawn, readFileSync(join(out, 'static', file), 'utf8'))).toEqual(DRAWN[path]!(drawn))
    }
  }, 120_000)
})

/** Clicks `sel` and waits for its text to become `text`. */
async function click(p: Page, sel: string, text: string | RegExp) {
  await p.click(sel)
  await p.waitForFunction(
    ([s, t, re]) => {
      const v = document.querySelector(s as string)?.textContent?.trim() ?? ''
      return re ? new RegExp(t as string).test(v) : v === t
    },
    [sel, typeof text === 'string' ? text : text.source, typeof text !== 'string'] as const,
    { timeout: 5000 },
  )
}

/** Console errors, less the browser's own line for a document served at the 4xx status the case asks for. */
const errorsOf = (p: Page) => (p as Page & { errors: string[] }).errors.filter((e) => !/^Failed to load resource: the server responded with a status of 40[34]/.test(e))

describe('the drawn hosts work (Chromium)', () => {
  test('case 1: the always-drawn host, one, and all six', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/1/none`)
    await click(p, '#always', 'Always 1')
    await p.goto(`${drawn.base}/1/w1`)
    await click(p, '#w1', 'W1 1')
    await p.goto(`${drawn.base}/1/all`)
    for (const w of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) await click(p, `#${w}`, `${w.toUpperCase()} 1`)
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 2: a state branch hidden at first paint: toggled in, its host works', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/2`)
    expect(await p.isVisible('#w1')).toBe(false)
    await p.click('#tg')
    await click(p, '#w1', 'W1 1')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 3: a branch over a live prop of a native parent', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/3`)
    await p.click('#outer')
    await click(p, '#w2', 'W2 1')
    await click(p, '#inner', 'inner 1')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 4a-4c: zero rows on the server, rows from an action, a row child and its child work', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/4/empty`)
    expect(await p.locator('li:not([hidden]) .card').count()).toBe(0)
    await p.click('#fill')
    await p.waitForSelector('li:not([hidden]) .card[data-id="b"]')
    await click(p, '.card[data-id="a"] .count', 'A 1')
    await click(p, '.card[data-id="b"] .count', 'B 1')
    await click(p, '.card[data-id="a"] .motion', 'moving')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 4d: rows on the server, emptied on the client, then refilled', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/4/full`)
    await click(p, '.card[data-id="z"] .count', 'Z 1')
    await p.click('#empty')
    await p.waitForFunction(() => document.querySelectorAll('li:not([hidden]) .card').length === 0)
    await p.click('#fill')
    await p.waitForSelector('li:not([hidden]) .card[data-id="a"]')
    await click(p, '.card[data-id="a"] .count', 'A 1')
    await click(p, '.card[data-id="a"] .motion', 'moving')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 5: a host inside a host inside a hidden copy', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/5`)
    await p.click('#nest')
    await click(p, '#mid', 'mid 1')
    await click(p, '#leaf', 'leaf 1')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 6: a native component inside a React island is drawn by the island (React)', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/6`)
    await click(p, '#frame-btn', 'frame 1')
    await click(p, '#w3', 'W3 1')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 7: SPA navigation to a page that draws W1 and back, then a full load of each', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/1/none`)
    await p.evaluate(() => {
      ;(window as unknown as { __same: boolean }).__same = true
    })
    await p.click('#to-w1')
    await p.waitForSelector('#w1')
    expect(await p.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)
    await click(p, '#w1', 'W1 1')
    await p.goBack()
    await p.waitForFunction(() => !document.querySelector('#w1'))
    expect(await p.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)
    await click(p, '#always', /^Always \d+$/)
    await p.click('#to-all')
    await p.waitForSelector('#w6')
    await click(p, '#w6', 'W6 1')
    for (const u of ['/1/none', '/1/w1']) {
      await p.goto(drawn.base + u)
      await click(p, '#always', 'Always 1')
    }
    await click(p, '#w1', 'W1 1')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 9: a layout host on a 200, a 404 and a 403 page; the page host on its own page', async () => {
    const p = await page()
    for (const u of ['/9/none', '/9/gone', '/9/deny']) {
      await p.goto(drawn.base + u)
      await click(p, '#lw', 'layout 1')
    }
    await p.goto(`${drawn.base}/9/w4`)
    await click(p, '#w4', 'W4 1')
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 13: the load-time code of a kept chunk runs on a page that draws none of its hosts; the drawn ones work', async () => {
    const p = await page()
    await p.goto(`${drawn.base}/13/none`)
    await p.waitForFunction(() => (globalThis as { __busy?: number }).__busy === 1)
    // tidy's counter is the module caller's chunk already bumped at load (that chunk is carried on every page): 2, as in
    // React, which loads every module the route imports.
    for (const [k, text] of [
      ['busy', 'busy 1'],
      ['tidy', 'tidy 2'],
      ['caller', 'caller 1'],
      ['forms', 'forms x,y 3 true 2 2 https://example.com/terms'],
    ] as const) {
      await p.goto(`${drawn.base}/13/${k}`)
      await click(p, `#${k}`, text)
    }
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })

  test('case 11: each host-specialised copy works on the page that prints it', async () => {
    const p = await page()
    for (const u of ['/11/a', '/11/b', '/11/ab'])
      for (const site of u === '/11/ab' ? ['A', 'B'] : [u.slice(-1).toUpperCase()]) {
        await p.goto(drawn.base + u)
        await click(p, `#site-${site}`, `site ${site}`)
        await p.waitForFunction((s) => document.querySelector(`#box-${s}`)?.textContent === `${s} on`, site)
        await p.click(`#box-${site}`)
        await p.waitForFunction((s) => document.querySelector(`#box-${s}`)?.closest('.box')?.getAttribute('data-n') === '1', site)
      }
    expect(errorsOf(p)).toEqual([])
    await p.close()
  })
})
