// F495 `[server] base_path`: the config layers, the build-time checks and the URL builders that need no server. The served
// test of two apps behind one origin is base-path-served.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadBuildConfig } from '../src/build/config'
import { headersFile, layoutAssets } from '../src/build/cf-assets'
import { leakedLocalPaths } from '../src/build/css'
import { cssSwapMap } from '../src/dev/bun'
import { devPaths, inject } from '../src/dev/proxy'
import { loadConfig, normalizeBasePath } from '../src/config'
import { BrustRouteError, checkBasePath, type FlatRoute } from '../src/routes'
import { basePathMismatch } from '../src/run'

const dirs: string[] = []
function tmp(files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-base-'))
  dirs.push(d)
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(dirname(join(d, k)), { recursive: true })
    writeFileSync(join(d, k), v)
  }
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('normalizeBasePath: a mount path, or the reason it is refused; "" and "/" are the root', () => {
  expect(normalizeBasePath('/portal')).toEqual({ ok: true, value: '/portal' })
  expect(normalizeBasePath('/a/b-c_d.e~f')).toEqual({ ok: true, value: '/a/b-c_d.e~f' })
  expect(normalizeBasePath('/')).toEqual({ ok: true, value: '' })
  expect(normalizeBasePath('')).toEqual({ ok: true, value: '' })
  for (const bad of ['portal', '/portal/', '/a//b', '/a/./b', '/a/..', '/{id}', '/a/*', '/a?x', '/a#x', '/a b', '/ข่าว', '/a%20b', 3, null]) {
    expect(normalizeBasePath(bad).ok).toBe(false)
  }
})

test('[server] base_path: toml and run({ config }) set it; nothing set leaves it absent', async () => {
  expect((await loadConfig(tmp())).basePath).toBeUndefined()
  const dir = tmp({ 'brust.toml': '[server]\nbase_path = "/portal"\n' })
  expect((await loadConfig(dir)).basePath).toBe('/portal')
  expect((await loadConfig(dir, { basePath: '/other' })).basePath).toBe('/other')
  expect((await loadConfig(dir, { basePath: '/' })).basePath).toBe('')
  await expect(loadConfig(dir, { basePath: 'x' })).rejects.toThrow('config.basePath must start with')
  await expect(loadConfig(tmp({ 'brust.toml': '[server]\nbase_path = "/p/"\n' }))).rejects.toThrow('server.base_path must not end with')
})

test('the build reads [server] base_path; the default actions prefix lives under it, an explicit one must too', async () => {
  const root = await loadBuildConfig(tmp({ 'brust.toml': '[actions]\n' }))
  expect([root.basePath, root.actions?.prefix]).toEqual(['', '/_brust/action'])
  const under = await loadBuildConfig(tmp({ 'brust.toml': '[server]\nbase_path = "/portal"\n[actions]\n' }))
  expect([under.basePath, under.actions?.prefix]).toEqual(['/portal', '/portal/_brust/action'])
  const own = await loadBuildConfig(tmp({ 'brust.toml': '[server]\nbase_path = "/portal"\n[actions]\nprefix = "/portal/api"\n' }))
  expect(own.actions?.prefix).toBe('/portal/api')
  await expect(loadBuildConfig(tmp({ 'brust.toml': '[server]\nbase_path = "/portal"\n[actions]\nprefix = "/api"\n' }))).rejects.toThrow('must lie under server.base_path "/portal"')
  await expect(loadBuildConfig(tmp({ 'brust.toml': '[server]\nbase_path = "oops"\n' }))).rejects.toThrow('server.base_path must start with')
})

const leaf = (id: string, pattern: string, catchAll = false) => ({ id, pattern, catchAll }) as unknown as FlatRoute

test('routes outside base_path are a named build error that lists them; the root * stays', () => {
  checkBasePath([leaf('r0', '/'), leaf('r1', '/x/{id}')], '')
  checkBasePath([leaf('r0', '/portal'), leaf('r1', '/portal/orders/{id}'), leaf('r2', '*', true)], '/portal')
  let err: unknown
  try {
    checkBasePath([leaf('r0', '/portal'), leaf('r1', '/'), leaf('r2', '/portalx'), leaf('r3', '/{tenant}')], '/portal')
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(BrustRouteError)
  expect((err as BrustRouteError).rule).toBe('route-outside-base-path')
  expect((err as Error).message).toContain('r1 (/), r2 (/portalx), r3 (/{tenant})')
  expect((err as Error).message).not.toContain('r0')
})

test('brust start refuses a manifest built for another base path; a config that sets none takes the manifest', () => {
  expect(basePathMismatch({ basePath: undefined }, { base_path: '/portal' })).toBeNull()
  expect(basePathMismatch({ basePath: '/portal' }, { base_path: '/portal' })).toBeNull()
  expect(basePathMismatch({ basePath: '' }, {})).toBeNull()
  expect(basePathMismatch({ basePath: '/a' }, { base_path: '/b' })).toContain('base-path-mismatch')
  expect(basePathMismatch({ basePath: '/a' }, {})).toContain('this build is for the root')
  expect(basePathMismatch({ basePath: '' }, { base_path: '/b' })).toContain('rebuild')
})

test('the Cloudflare / static asset tree and its _headers sit under the base path', () => {
  const out = tmp({ 'client/a-0123456789.js': 'x', 'public/img/p.png': 'y' })
  const cf = tmp()
  const { files } = layoutAssets(out, cf, '2.0.0', '/portal')
  expect(files).toEqual(['portal/_brust/client/a-0123456789.js', 'portal/public/img/p.png'])
  const headers = readFileSync(join(cf, 'assets', '_headers'), 'utf8')
  expect(headers).toContain('/portal/_brust/client/*\n  Cache-Control')
  expect(headers).toContain('/portal/public/img/p.png\n  Cache-Control')
  expect(headers).not.toContain('\n/_brust/client/*')
  // the root app is unchanged
  expect(layoutAssets(out, tmp(), '2.0.0').files).toEqual(['_brust/client/a-0123456789.js', 'public/img/p.png'])
  expect(headersFile(['public/a.css'], '2.0.0').text).toContain('/public/a.css')
})

test('dev: the channel URLs, the injected scripts and the css swap map carry the base path', () => {
  expect(devPaths('/portal').ws).toBe('/portal/_brust/dev/ws')
  expect(devPaths().client).toBe('/_brust/dev/client.js')
  expect(inject('<head></head>', 3, null, '/portal')).toBe('<head><script type="module" src="/portal/_brust/dev/client.js?g=3"></script><script type="module" src="/portal/_brust/dev/devtools.js"></script></head>')
  const a = tmp({ 'client/app-0123456789.css': '' })
  const b = tmp({ 'client/app-abcdef0123.css': '' })
  expect(cssSwapMap(a, b, '/portal')).toEqual({ '/portal/_brust/client/app-0123456789.css': '/portal/_brust/client/app-abcdef0123.css' })
  expect(cssSwapMap(a, b)).toEqual({ '/_brust/client/app-0123456789.css': '/_brust/client/app-abcdef0123.css' })
})

test('css: a url() under the base path is brust\'s own, not a file on this machine', () => {
  const css = 'a{background:url(/portal/public/x.png)}b{background:url(/portal/_brust/client/y.png)}'
  expect(leakedLocalPaths(css, ['/work/app'], '/portal')).toEqual([])
  expect(leakedLocalPaths('a{background:url(/work/app/z.png)}', ['/work/app'], '/portal')).toEqual(['/work/app/z.png'])
})
