// Slow: the PUBLISHED shape end to end (M3-F §4.2/§4.3). create-app, core and runtime-dom come from `bun pm pack` tarballs,
// the host native is a file: dir, and `bun install` fetches react/elysia from npm. Run alone:
// `cd packages/create-app && bun test --timeout 600000 test/scaffold.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coreCfSource, host, hostNative, packAll, packCoreCf, REPO, type Running, sh, startApp } from './helpers.ts'

let work = ''
let tgz: ReturnType<typeof packAll>
let native: ReturnType<typeof hostNative>
let hostDir = ''
let coreCfTgz: string | null = null
const CF_SRC = coreCfSource()
const running: Running[] = []
const T = 300_000

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ca-scaffold-'))
  tgz = packAll(work)
  native = hostNative(work)
  hostDir = host(work, tgz.createApp)
  if (CF_SRC) coreCfTgz = packCoreCf(work, CF_SRC)
}, 600_000)
afterAll(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => {})
  rmSync(work, { recursive: true, force: true })
})

const walk = (d: string, base = d): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)]))
const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
function setOverrides(dir: string, extra: Record<string, string> = {}) {
  const pkg = readPkg(dir)
  pkg.overrides = { '@brust/runtime-dom': `file:${tgz.runtimeDom}`, [native.name]: `file:${native.dir}`, '@brust/core-cf': coreCfTgz ? `file:${coreCfTgz}` : `file:${REPO}/npm/core-cf`, ...extra }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}
function scaffold(name: string, template: string): string {
  const dir = join(work, 'apps', name)
  const out = sh(['bun', 'create', '@brust/app', name, '--template', template, '--dir', dir, '--brust-dep', `file:${tgz.core}`, '--yes'], hostDir)
  expect(out).toContain('Next:')
  return dir
}
async function start(dir: string, env: Record<string, string> = {}) { const r = await startApp(dir, env); running.push(r); return r }
const stopOne = async (r: Running) => { await r.stop(); running.splice(running.indexOf(r), 1) }
const post = (base: string, id: number) => fetch(`${base}/_brust/action/team`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })

test('bun create @brust/app (packed create-app) scaffolds blank with long flags only', () => {
  const dir = scaffold('blank-app', 'blank')
  const files = walk(dir)
  expect(files.some((f) => f.endsWith('.tmpl') || f.includes('_gitignore'))).toBe(false)
  expect(files).toContain('.gitignore')
  for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/__PROJECT_NAME__|__BRUST_DEP__/)
  const pkg = readPkg(dir)
  expect(pkg.name).toBe('blank-app')
  expect(pkg.dependencies['@brust/core']).toBe(`file:${tgz.core}`)
}, T)

test('blank: install → build → typecheck → start; / is the native counter; the hello action answers through Rust', async () => {
  const dir = join(work, 'apps/blank-app')
  setOverrides(dir)
  sh(['bun', 'install'], dir)
  sh(['bun', 'run', 'build'], dir)
  expect(existsSync(join(dir, 'dist/native'))).toBe(false) // F85: the addon resolves from @brust/native-<plat>, nothing is copied
  expect(sh(['bun', 'run', 'typecheck'], dir)).toMatch(/No type errors/)
  const app = await start(dir)
  const page = await fetch(`${app.base}/`)
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('count is')
  expect(html).toContain('x-data="counter_')
  expect(html).toContain('<svg class="mark"') // R25: the brust mark is inline, not an <img>
  expect(html).toContain('/public/favicon.svg')
  // R25.4: HomePage static, Counter native, no react chunk.
  const manifest = JSON.parse(readFileSync(join(dir, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier?: string }> }
  const tierOf = (prefix: string) => Object.entries(manifest.components).find(([id]) => id.startsWith(prefix))?.[1].tier
  expect([tierOf('homePage_'), tierOf('counter_')]).toEqual(['static', 'native'])
  expect(Object.values(manifest.components).map((c) => c.tier)).not.toContain('react')
  const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!)
  expect(srcs.length).toBeGreaterThan(0)
  for (const s of srcs) expect((await fetch(new URL(s, app.base))).status, s).toBe(200)
  const hello = await fetch(`${app.base}/_brust/action/hello?name=ash`)
  expect(hello.status).toBe(200)
  expect(await hello.json()).toEqual({ message: 'Hello, ash!' })
  const nope = await fetch(`${app.base}/_brust/action/nope`)
  expect(nope.status).toBe(404)
  expect(nope.headers.get('content-type')).toContain('application/problem+json')
  await stopOne(app)
}, T)

test('pokedex: scaffold → install → build → start; /pokemon/pikachu renders; POST adds; SSR team shows it; a restart keeps it', async () => {
  const dir = scaffold('dex-app', 'pokedex')
  expect(existsSync(join(dir, 'data/pokedex.json'))).toBe(true)
  expect(existsSync(join(dir, 'data/team.sqlite'))).toBe(false)
  expect(existsSync(join(dir, 'test'))).toBe(false)
  setOverrides(dir)
  sh(['bun', 'install'], dir)
  sh(['bun', 'run', 'build'], dir)
  const a = await start(dir) // no POKEDEX_TEAM_DB: the default <cwd>/data/team.sqlite is exercised
  const p = await fetch(`${a.base}/pokemon/pikachu`)
  expect(p.status).toBe(200)
  expect(await p.text()).toContain('Pikachu')
  const added = await post(a.base, 25)
  expect(added.status).toBe(200)
  expect(((await added.json()) as { team: { id: number }[] }).team.map((m) => m.id)).toContain(25)
  const home = await (await fetch(`${a.base}/`)).text()
  expect(home).toMatch(/data-testid="team-count"[^>]*>1</)
  await stopOne(a)
  const b = await start(dir)
  const again = (await (await fetch(`${b.base}/_brust/action/team`)).json()) as { team: { id: number }[] }
  expect(again.team.map((m) => m.id)).toContain(25)
  expect(existsSync(join(dir, 'data/team.sqlite'))).toBe(true)
  await stopOne(b)
}, T)

test('monorepo mode: blank without --brust-dep installs from file: + overrides and builds', () => {
  const dir = join(work, 'apps/mono-app')
  sh(['bun', join(REPO, 'packages/create-app/bin/create-app.ts'), 'mono-app', '--template', 'blank', '--dir', dir, '--yes'], work)
  const pkg = readPkg(dir)
  expect(pkg.dependencies['@brust/core']).toBe(`file:${REPO}/packages/brust`)
  expect(Object.keys(pkg.overrides)).toHaveLength(8)
  sh(['bun', 'install'], dir)
  sh(['bun', 'run', 'build'], dir)
  expect(existsSync(join(dir, 'dist/manifest.json'))).toBe(true)
}, T)

// R6: runs only with a built wasm (the ci `cf` job builds it; BRUST_CORE_CF_DIR points at the release-shaped package). The app build runs
// WITHOUT BRUST_CORE_CF_DIR, so the resolution proven is the published layout: @brust/core-cf installed beside @brust/core.
test.skipIf(!CF_SRC)('blank --target cloudflare from packed tarballs resolves @brust/core-cf; wrangler deploy --dry-run bundles it', () => {
  const dir = scaffold('cf-app', 'blank')
  setOverrides(dir)
  sh(['bun', 'install'], dir)
  const env = { ...process.env } as Record<string, string | undefined>
  delete env.BRUST_CORE_CF_DIR
  const run = (cmd: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(cmd, { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', ...extra } as Record<string, string> })
    const out = r.stdout.toString() + r.stderr.toString()
    if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited ${r.exitCode}:\n${out}`)
    return out
  }
  run(['./node_modules/.bin/brust', 'build', 'routes.tsx', '--target', 'cloudflare'])
  const sha = (f: string) => new Bun.CryptoHasher('sha256').update(readFileSync(f)).digest('hex')
  expect(sha(join(dir, 'dist/cf/worker/index_bg.wasm'))).toBe(sha(join(CF_SRC!, 'worker/index_bg.wasm')))
  expect(existsSync(join(dir, 'dist/cf/worker/brust-app.js'))).toBe(true)
  expect((Bun.JSONC.parse(readFileSync(join(dir, 'dist/cf/wrangler.jsonc'), 'utf8')) as { main: string }).main).toBe('worker/index.js')
  const out = run(['./node_modules/.bin/wrangler', 'deploy', '--dry-run', '--outdir', join(work, 'cf-bundle'), '-c', 'dist/cf/wrangler.jsonc'], { WRANGLER_SEND_METRICS: 'false', CI: '1' })
  expect(out).toMatch(/Total Upload/)
}, 600_000)
