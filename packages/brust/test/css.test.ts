// L19 css-pipeline (R19.1-R19.4): which stylesheets a route links and in what order, one minified
// content-hashed file per source, CSS Module class maps through one plugin in every JS build, relative
// url() assets, `[css] global`, and the server's injection, end to end on test/fixtures/css-app with the
// real CLI. The Chromium half (computed styles, islands) is tests/server/css.chromium.test.ts.
// Run alone: `bun test --timeout 300000 test/css.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBuildConfig } from '../src/build/config'
import { buildCss, CssGraph, cssPlugin, routeCssSources } from '../src/build/css'
import { flattenRoutes, type Route } from '../src/routes'

const fixture = join(import.meta.dir, 'fixtures/css-app')
const bin = join(import.meta.dir, '../bin/brust')
const temps: string[] = []
const copies: string[] = []
type Manifest = { routes: { id: string; pattern: string; css?: string[] }[] }
let manifest: Manifest
let buildOut = ''

function build(cwd: string, ...args: string[]) {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: b.exitCode, stdout: b.stdout.toString(), stderr: b.stderr.toString() }
}
function tmp(files: Record<string, string | Uint8Array>): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-css-')))
  temps.push(d)
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(join(d, k, '..'), { recursive: true })
    writeFileSync(join(d, k), v)
  }
  return d
}
/** A copy of the fixture inside the package (so `@brust/core` resolves), changed by `edit`. */
function variant(name: string, edit: (dir: string) => void): string {
  const dir = join(import.meta.dir, `fixtures/.css-${name}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes('/dist') })
  copies.push(dir)
  edit(dir)
  return dir
}
const cssOf = (m: Manifest, pattern: string) => (m.routes.find((r) => r.pattern === pattern)?.css ?? []).map((f) => f.replace(/-[0-9a-f]{10}\.css$/, '.css'))

beforeAll(() => {
  rmSync(join(fixture, 'dist'), { recursive: true, force: true })
  const b = build(fixture)
  if (b.code !== 0) throw new Error(`brust build failed:\n${b.stderr}`)
  buildOut = b.stdout
  manifest = JSON.parse(readFileSync(join(fixture, 'dist/manifest.json'), 'utf8'))
}, 300_000)

afterAll(() => {
  for (const d of [join(fixture, 'dist'), ...copies, ...temps]) rmSync(d, { recursive: true, force: true })
})

test('R19.1: [css] global first, then chain order (layout → page), depth-first, first occurrence wins', () => {
  expect(cssOf(manifest, '/')).toEqual(['client/global.css', 'client/layout.css', 'client/Card.module.css', 'client/home.css'])
  expect(cssOf(manifest, '/other')).toEqual(['client/global.css', 'client/layout.css', 'client/Card.module.css', 'client/other.css'])
  expect(cssOf(manifest, '/native')).toEqual(['client/global.css', 'client/layout.css', 'client/Btn.module.css'])
  // the page's children are walked too (Islands → Counter, Wide), and a module two files import is listed once
  expect(cssOf(manifest, '/islands')).toEqual(['client/global.css', 'client/layout.css', 'client/Island.module.css'])
  // no layout: the global, then the page
  expect(cssOf(manifest, '/bare')).toEqual(['client/global.css', 'client/Card.module.css', 'client/other.css'])
})

test('R19.2: one minified, content-hashed file per source; a shared file is one URL; no .min. infix', () => {
  const client = readdirSync(join(fixture, 'dist/client'))
  const css = client.filter((f) => f.endsWith('.css')).sort()
  expect(css.map((f) => f.replace(/-[0-9a-f]{10}\.css$/, ''))).toEqual(['Btn.module', 'Card.module', 'Island.module', 'global', 'home', 'layout', 'other'])
  expect(css.every((f) => /-[0-9a-f]{10}\.css$/.test(f) && !f.includes('.min.'))).toBe(true)
  const home = manifest.routes.find((r) => r.pattern === '/')!.css!
  const other = manifest.routes.find((r) => r.pattern === '/other')!.css!
  expect(home[2]).toBe(other[2])
  // @import inlined, nesting flattened, minified
  expect(readFileSync(join(fixture, 'dist', home[1]!), 'utf8')).toBe('p{padding-left:7px}h1{color:#0a141e;font-size:31px}main h2{color:#040506}\n')
  // no JS build emitted CSS: the only stylesheets are the per-source files
  expect(client.filter((f) => f.endsWith('.css')).length).toBe(7)
})

test('R19.4: the class map is the same in jobs.js and the client chunk, and the classes are in the CSS', () => {
  const card = readFileSync(join(fixture, 'dist', manifest.routes[0]!.css![2]!), 'utf8')
  const classes = [...card.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!)
  expect(classes.length).toBe(2)
  const jobs = readFileSync(join(fixture, 'dist/jobs.js'), 'utf8')
  for (const c of classes) expect(jobs).toContain(c)
  // A React island renders className itself, so its chunk carries the map.
  const isl = readFileSync(join(fixture, 'dist', manifest.routes.find((r) => r.pattern === '/islands')!.css![2]!), 'utf8')
  const islClass = /\.([A-Za-z_][\w-]*)/.exec(isl)![1]!
  // (both islands import the module, so code splitting puts the map in a shared chunk)
  const js = readdirSync(join(fixture, 'dist/client')).filter((f) => f.endsWith('.js'))
  expect(js.filter((f) => readFileSync(join(fixture, 'dist/client', f), 'utf8').includes(islClass)).length).toBe(1)
})

test('R19.3: the server links the route CSS right after <head> / <meta charset>, before the author tags; no head: first', async () => {
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: fixture, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  try {
    const base = `http://${/listening on (\S+)/.exec(log)![1]}`
    const links = (pattern: string) =>
      manifest.routes
        .find((r) => r.pattern === pattern)!
        .css!.map((f) => `<link rel="stylesheet" href="/_brust/${f}" data-brust-css>`)
        .join('')
    const home = (await (await fetch(`${base}/`)).text()).trimStart()
    expect(home).toStartWith(`<html lang="en"><head><meta charSet="utf-8">${links('/')}<title>css fixture</title><link rel="stylesheet" href="/public/user.css"></head>`)
    expect(home).toContain('<header>top</header>')
    const bare = await (await fetch(`${base}/bare`)).text()
    // the native page's static className is the module's class
    const btn = readFileSync(join(fixture, 'dist', manifest.routes.find((r) => r.pattern === '/native')!.css![2]!), 'utf8')
    expect(await (await fetch(`${base}/native`)).text()).toContain(`class="${/\.([A-Za-z_][\w-]*)/.exec(btn)![1]!}"`)
    expect(bare).toStartWith(`${links('/bare')}\n<section>`)
    for (const f of manifest.routes[0]!.css!) {
      const r = await fetch(`${base}/_brust/${f}`)
      expect([f, r.status, r.headers.get('content-type'), r.headers.get('cache-control')]).toEqual([f, 200, 'text/css; charset=utf-8', 'public, max-age=31536000, immutable'])
    }
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 60_000)

test('relative url() fonts are emitted as hashed client assets; /public and /_brust stay as written', async () => {
  const font = new Uint8Array(200_000).map((_, i) => (i * 7) % 251)
  const d = tmp({
    'fonts/Inter Var.woff2': font,
    'a.css': "@font-face{font-family:I;src:url('./fonts/Inter Var.woff2') format('woff2')} body{background:url(/public/bg.png)} .x{background:url(/_brust/client/y.png)}",
  })
  const dist = tmp({ 'client/.keep': '' })
  const r = await buildCss(dist, [join(d, 'a.css')])
  const out = readFileSync(join(dist, r.file.get(join(d, 'a.css'))!), 'utf8')
  const asset = readdirSync(join(dist, 'client')).find((f) => f.endsWith('.woff2'))!
  expect(asset).toMatch(/^Inter_Var-[0-9a-f]{10}\.woff2$/)
  expect(out).toContain(`url(./${asset})`)
  expect(out).toContain('url(/public/bg.png)')
  expect(out).toContain('url(/_brust/client/y.png)')
  expect(readFileSync(join(dist, 'client', asset)).length).toBe(200_000)
})

test('the import walk: chain order, depth-first, first occurrence, cycles, package CSS, node_modules JS not followed', () => {
  const d = tmp({
    'node_modules/ui/style.css': '.ui{}',
    'node_modules/ui/index.js': "import './inner.css'\nexport const x = 1",
    'node_modules/ui/inner.css': '.inner{}',
    'node_modules/ui/package.json': '{"name":"ui","main":"index.js"}',
    'L.tsx': "import './l.css'\nimport { a } from './a'\nimport 'ui/style.css'\nexport default function L() { return a }",
    'a.ts': "import './a.css'\nimport { b } from './b'\nimport { x } from 'ui'\nexport const a = b + x",
    'b.ts': "import './l.css'\nimport './b.css'\nimport { a } from './a'\nexport const b = 1",
    'P.tsx': "import './b.css'\nimport './p.css'\nexport default function P() { return null }",
    'l.css': '', 'a.css': '', 'b.css': '', 'p.css': '',
  })
  const L = () => null
  const P = () => null
  const files = new Map<Function, string>([
    [L, join(d, 'L.tsx')],
    [P, join(d, 'P.tsx')],
  ])
  const leaves = flattenRoutes([{ Component: L, children: [{ path: '/', Component: P }] }] as Route[]).leaves
  const got = routeCssSources(leaves, (l) => l.chain.flatMap((n) => (n.Component ? [files.get(n.Component)!] : [])), [join(d, 'g.css')], new CssGraph())
  expect(got.get('r1')!.map((p) => p.slice(d.length + 1))).toEqual(['g.css', 'l.css', 'a.css', 'b.css', 'node_modules/ui/style.css', 'p.css'])
})

test('cssPlugin: a module is its frozen map, plain CSS is empty, an unbuilt module fails the build', async () => {
  const d = tmp({
    'x.module.css': '.a{}',
    'y.css': 'body{}',
    'z.module.css': '.z{}',
    'e.ts': "import s from './x.module.css'\nimport './y.css'\nexport default s",
    'f.ts': "import s from './z.module.css'\nexport default s",
  })
  const maps = new Map([[join(d, 'x.module.css'), { a: 'a_HASH' }]])
  const ok = await Bun.build({ entrypoints: [join(d, 'e.ts')], target: 'browser', plugins: [cssPlugin(maps)] })
  expect(ok.success).toBe(true)
  expect(ok.outputs.map((o) => o.path.endsWith('.css'))).toEqual([false])
  expect(await ok.outputs[0]!.text()).toContain('Object.freeze({ a: "a_HASH" })')
  const bad = await Bun.build({ entrypoints: [join(d, 'f.ts')], target: 'browser', plugins: [cssPlugin(maps)], throw: false })
  expect(bad.success).toBe(false)
  expect(bad.logs.map(String).join('\n')).toContain("z.module.css is imported by code the build did not reach from a route")
})

test('[css] config: global is a list of .css paths; anything else is a config error', async () => {
  const app = (toml: string) => tmp({ 'brust.toml': toml })
  expect((await loadBuildConfig(app('[css]\nglobal = ["styles/a.css", "b.css"]\n'))).cssGlobal).toEqual(['styles/a.css', 'b.css'])
  expect((await loadBuildConfig(app(''))).cssGlobal).toEqual([])
  const err = async (toml: string) => loadBuildConfig(app(toml)).then(() => '', (e) => (e as Error).message)
  expect(await err('[css]\nglobal = ["a.scss"]\n')).toContain('css.global must be an array of .css paths')
  expect(await err('[css]\nmodules = true\n')).toContain('unknown key css.modules (allowed: global)')
})

test('a missing [css] global file fails the build; CSS imported by the route entry warns (it belongs to no route)', () => {
  const missing = variant('missing', (d) => writeFileSync(join(d, 'brust.toml'), '[css]\nglobal = ["nope.css"]\n'))
  const m = build(missing)
  expect([m.code, m.stderr.trim()]).toEqual([1, 'error css css.global nope.css is not a file inside the app'])
  expect(buildOut).not.toContain('warning css')
  const entry = variant('entry', (d) => writeFileSync(join(d, 'routes.tsx'), `import './styles/global.css'\n${readFileSync(join(d, 'routes.tsx'), 'utf8')}`))
  const e = build(entry)
  expect(e.code).toBe(0)
  expect(e.stdout).toContain('[brust] warning css routes.tsx imports ./styles/global.css: the route entry belongs to no route')
}, 120_000)

test('--target cloudflare: the stylesheets are Static Assets and the worker bundles the class maps', () => {
  const cfCore = join(import.meta.dir, 'fixtures/cf-core')
  const out = mkdtempSync(join(tmpdir(), 'brust-css-cf-'))
  temps.push(out)
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', out, '--force'], { cwd: fixture, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRUST_CORE_CF_DIR: cfCore } })
  expect([b.exitCode, b.stderr.toString()]).toEqual([0, ''])
  const assets = readdirSync(join(out, 'cf/assets/_brust/client')).filter((f) => f.endsWith('.css'))
  expect(assets.length).toBe(7)
  const card = readFileSync(join(fixture, 'dist', manifest.routes[0]!.css![2]!), 'utf8')
  const cls = /\.([A-Za-z_][\w-]*)/.exec(card)![1]!
  const worker = readdirSync(join(out, 'cf/worker'), { recursive: true }).map(String).find((f) => f.endsWith('brust-app.js'))!
  expect(readFileSync(join(out, 'cf/worker', worker), 'utf8')).toContain(cls)
}, 120_000)
