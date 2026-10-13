// Gaps round L16 (R16.1-R16.5): the action base URL and credentials as runtime configuration, the client's
// resolution order, the actions-only build, the page-only build, and the root prefix. The two-origin Chromium run is
// tests/server/actions-standalone.chromium.test.ts; the Cloudflare half is tests/cf/actions-standalone.test.ts.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseUrlError, prefixError } from '../src/actions/prefix'
import { client, resolveBaseUrl, resolvePrefix } from '../src/actions/client'
import { loadBuildConfig } from '../src/build/config'
import { BrustConfigError, type BrustConfig, loadConfig } from '../src/config'
import { startOptions } from '../src/run'
import fixtureApp, { type App } from './fixtures/actions/app'
import { mountActions } from '../src/actions/load'

const dirs: string[] = []
const tmp = (toml?: string) => {
  const d = mkdtempSync(join(tmpdir(), 'brust-l16-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const envKeys = ['BRUST_ACTIONS_BASE_URL', 'BRUST_PORT', 'BRUST_ADDR']
afterEach(() => {
  for (const k of envKeys) delete process.env[k]
  const g = globalThis as Record<string, unknown>
  for (const k of ['__BRUST_ACTION_PREFIX__', '__BRUST_ACTION_BASE__', '__BRUST_ACTION_CREDENTIALS__']) delete g[k]
})

describe('R16.1 base_url: validation', () => {
  test('an absolute http(s) origin only', () => {
    for (const ok of ['https://api.example.com', 'http://127.0.0.1:4000', 'https://a.b.c:8443']) expect(baseUrlError(ok)).toBeNull()
    for (const bad of ['api.example.com', 'ftp://x', 'https://x/path', 'https://x/', 'https://x?q=1', 'https://x#f', 'https://u:p@x', '', 3, undefined])
      expect(baseUrlError(bad), String(bad)).toStartWith('must be')
  })
  test('the root prefix is only for an actions-only build', () => {
    expect(prefixError('/')).toContain("longer than '/'")
    expect(prefixError('/', true)).toBeNull()
    expect(prefixError('/api', true)).toBeNull()
  })
})

describe('R16.1 precedence: env > run({ config }) > toml', () => {
  const toml = '[actions]\nbase_url = "https://toml.example"\ncredentials = "omit"\n'
  test('toml alone', async () => {
    const c = await loadConfig(tmp(toml), {})
    expect([c.actionsBaseUrl, c.actionsCredentials]).toEqual(['https://toml.example', 'omit'])
  })
  test('run({ config }) over toml, env over both', async () => {
    const d = tmp(toml)
    expect((await loadConfig(d, { actionsBaseUrl: 'https://run.example', actionsCredentials: 'include' })).actionsBaseUrl).toBe('https://run.example')
    process.env.BRUST_ACTIONS_BASE_URL = 'https://env.example'
    const c = await loadConfig(d, { actionsBaseUrl: 'https://run.example', actionsCredentials: 'include' })
    expect([c.actionsBaseUrl, c.actionsCredentials]).toEqual(['https://env.example', 'include'])
  })
  test('an empty env var counts as unset; nothing set → both absent', async () => {
    process.env.BRUST_ACTIONS_BASE_URL = ''
    const c = await loadConfig(tmp(), {})
    expect('actionsBaseUrl' in c || 'actionsCredentials' in c).toBe(false)
  })
  test('validation messages name the source', async () => {
    const msg = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as BrustConfigError).message
    const d = tmp('[actions]\nbase_url = "https://x/p"\n')
    expect(await msg(loadConfig(d, {}))).toBe(`${join(d, 'brust.toml')}: actions.base_url must be an origin only: no path, query, fragment or credentials (got "https://x/p")`)
    expect(await msg(loadConfig(tmp('[actions]\ncredentials = "always"\n'), {}))).toContain('actions.credentials must be one of same-origin, include, omit (got "always")')
    process.env.BRUST_ACTIONS_BASE_URL = 'nope'
    expect(await msg(loadConfig(tmp(), {}))).toStartWith('BRUST_ACTIONS_BASE_URL must be an absolute http(s) origin')
    delete process.env.BRUST_ACTIONS_BASE_URL
    expect(await msg(loadConfig(tmp(), { actionsBaseUrl: 'x' }))).toStartWith('config.actionsBaseUrl must be an absolute http(s) origin')
    expect(await msg(loadConfig(tmp(), { actionsCredentials: 'x' as never }))).toContain('config.actionsCredentials must be one of')
  })
})

describe('startOptions: actionsClient', () => {
  const base = { host: '127.0.0.1', port: 3000, workers: 2, callTimeoutMs: 5000 } as unknown as BrustConfig
  test('absent unless the page has something to be told beyond the prefix script', () => {
    expect('actionsClient' in startOptions(base, '/d', { actions: { entry: 'a.js', prefix: '/api', maxBodyBytes: 1 } }, 'v')).toBe(false)
    expect('actionsClient' in startOptions({ ...base, actionsCredentials: 'same-origin' }, '/d', {}, 'v')).toBe(false)
  })
  test('base and credentials ride with the local prefix', () => {
    const o = startOptions({ ...base, actionsBaseUrl: 'https://api.example.com', actionsCredentials: 'include' }, '/d', { actions: { entry: 'a.js', prefix: '/api', maxBodyBytes: 1 } }, 'v')
    expect(o.actionsClient).toEqual({ prefix: '/api', baseUrl: 'https://api.example.com', credentials: 'include' })
  })
  test('a page-only build carries the remote prefix with no local actions', () => {
    const o = startOptions({ ...base, actionsBaseUrl: 'https://api.example.com' }, '/d', { actions_remote: { prefix: '/' } }, 'v')
    expect(o.actionsClient).toEqual({ prefix: '/', baseUrl: 'https://api.example.com' })
    expect(o.actions).toBeUndefined()
  })
})

describe('R16.1/R16.2 client resolution order', () => {
  type Call = { url: string; init: RequestInit | undefined }
  const stub = (calls: Call[], prefix = '/_brust/action') => {
    const mounted = mountActions(fixtureApp as never, prefix)
    return (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const u = new URL(url, 'http://l')
      return mounted.fetch(new Request(`http://l${u.pathname}${u.search}`, init))
    }) as unknown as typeof fetch
  }
  const g = globalThis as Record<string, unknown>

  test('opts.baseUrl > the page base > relative', () => {
    expect(resolveBaseUrl()).toBe('')
    g.__BRUST_ACTION_BASE__ = 'https://page.example/'
    expect(resolveBaseUrl()).toBe('https://page.example')
    expect(resolveBaseUrl({ baseUrl: 'https://call.example' })).toBe('https://call.example')
  })
  test('the page base pairs with the page prefix; a per-call baseUrl keeps today\'s default prefix', () => {
    g.__BRUST_ACTION_BASE__ = 'https://page.example'
    g.__BRUST_ACTION_PREFIX__ = '/api'
    expect(resolvePrefix()).toBe('/api')
    expect(resolvePrefix({ baseUrl: 'https://call.example' })).toBe('/_brust/action')
    expect(resolvePrefix({ baseUrl: 'https://call.example', prefix: '/p' })).toBe('/p')
  })
  test('calls go to base + prefix; the root prefix adds nothing', async () => {
    const calls: Call[] = []
    g.__BRUST_ACTION_BASE__ = 'https://api.example.com'
    g.__BRUST_ACTION_PREFIX__ = '/api'
    await client<App>({ fetch: stub(calls, '/api') }).hello.get()
    expect(calls[0]?.url).toBe('https://api.example.com/api/hello')
    g.__BRUST_ACTION_PREFIX__ = '/'
    const root = stub(calls, '/')
    await client<App>({ fetch: root }).hello.get()
    expect(calls[1]?.url).toBe('https://api.example.com/hello')
  })
  test('credentials: the page default applies, opts.init overrides it, same-origin adds nothing', async () => {
    const calls: Call[] = []
    g.__BRUST_ACTION_CREDENTIALS__ = 'include'
    await client<App>({ fetch: stub(calls) }).hello.get()
    expect(calls[0]?.init?.credentials).toBe('include')
    await client<App>({ fetch: stub(calls), init: { credentials: 'omit' } }).hello.get()
    expect(calls[1]?.init?.credentials).toBe('omit')
    g.__BRUST_ACTION_CREDENTIALS__ = 'same-origin'
    await client<App>({ fetch: stub(calls) }).hello.get()
    expect(calls[2]?.init?.credentials).toBeUndefined()
  })
})

describe('[actions] build config (L16)', () => {
  test('base_url / credentials / entryExplicit; a bad one names the file', async () => {
    const c = await loadBuildConfig(tmp('[actions]\nbase_url = "https://api.example.com"\ncredentials = "include"\n'))
    expect([c.actions?.baseUrl, c.actions?.credentials, c.actions?.entryExplicit]).toEqual(['https://api.example.com', 'include', false])
    const d = tmp('[actions]\nbase_url = "x"\n')
    await expect(loadBuildConfig(d)).rejects.toThrow(`${join(d, 'brust.toml')}: actions.base_url must be an absolute http(s) origin`)
  })
  test('prefix "/" needs --actions-only or a base_url (a page-only build pointing at one)', async () => {
    await expect(loadBuildConfig(tmp('[actions]\nprefix = "/"\n'))).rejects.toThrow("actions.prefix must start with '/', be longer than '/'")
    expect((await loadBuildConfig(tmp('[actions]\nprefix = "/"\n'), { actionsOnly: true })).actions?.prefix).toBe('/')
    expect((await loadBuildConfig(tmp('[actions]\nprefix = "/"\nbase_url = "https://x.example"\n'))).actions?.prefix).toBe('/')
  })
})

// ---- the CLI builds ----
const FIX = join(import.meta.dir, 'fixtures/standalone')
const bin = join(import.meta.dir, '../bin/brust')
const CORE = join(import.meta.dir, 'fixtures/cf-core')
function app(name: string, toml: string, dir: 'api' | 'pages' = 'api'): string {
  const root = join(FIX, `.unit-${name}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  dirs.push(root)
  for (const d of ['api', 'pages']) cpSync(join(FIX, d), join(root, d), { recursive: true })
  writeFileSync(join(root, dir, 'brust.toml'), toml)
  return join(root, dir)
}
function brust(cwd: string, args: string[]) {
  const r = Bun.spawnSync([bin, ...args], { cwd, env: { ...process.env, BRUST_CORE_CF_DIR: CORE, BRUST_PORT: '', BRUST_ADDR: '' }, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('R16.3 --actions-only', () => {
  test('writes an actions-only dist: no routes, no templates, no routes entry needed', () => {
    const cwd = app('only', '[actions]\nentry = "actions.ts"\nprefix = "/"\n')
    const r = brust(cwd, ['build', '--actions-only'])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const m = JSON.parse(readFileSync(join(cwd, 'dist/manifest.json'), 'utf8'))
    expect(m).toMatchObject({ routes: [], components: {}, actions_only: true, actions: { entry: 'actions.js', prefix: '/' } })
    expect(existsSync(join(cwd, 'dist/actions.js'))).toBe(true)
    expect(existsSync(join(cwd, 'dist/client'))).toBe(false)
    expect(readFileSync(join(cwd, 'dist/index.js'), 'utf8')).not.toContain('BRUST_APP_ENTRY')
  })
  test('needs [actions]; refuses --target static; base_url is ignored with an info line', () => {
    const none = app('none', '[build]\n')
    expect(brust(none, ['build', '--actions-only']).err).toStartWith('error actions-only --actions-only needs an [actions] table')
    const st = app('static', '[actions]\nentry = "actions.ts"\n')
    expect(brust(st, ['build', '--actions-only', '--target', 'static']).err).toStartWith('error actions-only --actions-only builds no pages')
    const b = app('base', '[actions]\nentry = "actions.ts"\nbase_url = "https://x.example"\n')
    expect(brust(b, ['build', '--actions-only']).out).toContain('base_url is for the pages that call these actions (ignored here)')
  })
  test('a normal build refuses prefix "/" (its pages would be unreachable)', () => {
    const cwd = app('rootnormal', '[actions]\nentry = "actions.ts"\nprefix = "/"\n', 'pages')
    cpSync(join(FIX, 'api/actions.ts'), join(cwd, 'actions.ts'))
    expect(brust(cwd, ['build', 'routes.tsx']).err).toContain("actions.prefix must start with '/', be longer than '/'")
  })
  test('--target cloudflare: a Worker with only actions, no Static Assets', () => {
    const cwd = app('cf', '[actions]\nentry = "actions.ts"\nprefix = "/"\n')
    const r = brust(cwd, ['build', '--actions-only', '--target', 'cloudflare'])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const w = Bun.JSONC.parse(readFileSync(join(cwd, 'dist/cf/wrangler.jsonc'), 'utf8')) as Record<string, unknown>
    expect(w.assets).toBeUndefined()
    expect(existsSync(join(cwd, 'dist/cf/assets'))).toBe(false)
    const entry = readFileSync(join(cwd, 'dist/cf/.stage/brust-app.entry.js'), 'utf8')
    expect(entry).toContain('makeHandlers({ leaves: [], jobs: {}')
    expect(entry).not.toContain('import * as R')
    expect(entry).toContain('mountActions(A, "/")')
    expect(JSON.parse(readFileSync(join(cwd, 'dist/cf/.stage/templates.json'), 'utf8'))).toEqual({})
  })
})

describe('R16.4b page-only build', () => {
  test('[actions] base_url with no actions file bundles no actions and records the remote prefix', () => {
    const cwd = app('pageonly', '[actions]\nbase_url = "https://api.example.com"\nprefix = "/"\ncredentials = "include"\n', 'pages')
    const r = brust(cwd, ['build', 'routes.tsx'])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const m = JSON.parse(readFileSync(join(cwd, 'dist/manifest.json'), 'utf8'))
    expect(m.actions).toBeNull()
    expect(m.actions_remote).toEqual({ prefix: '/' })
    expect(existsSync(join(cwd, 'dist/actions.js'))).toBe(false)
  })
  test('an actions file named in the toml that is missing is still an error', () => {
    const cwd = app('typo', '[actions]\nentry = "nope.ts"\nbase_url = "https://api.example.com"\n', 'pages')
    expect(brust(cwd, ['build', 'routes.tsx']).err).toStartWith('error actions-entry actions.entry nope.ts is not a file inside the app')
  })
})
