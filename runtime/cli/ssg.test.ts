import { test, expect, beforeAll, afterAll } from 'bun:test'
import { $ } from 'bun'
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  collectStaticPaths,
  expandDynamicRoutes,
  exportStatic,
  fallbackDiskPath,
  fallbackEntrySource,
  fallbackSentinelPath,
  hasClientLoaderExport,
  navPayloadFileFor,
  type FlatRouteLike,
  type SsgRouteDecision,
} from './ssg.ts'

function route(fullPath: string, chain: FlatRouteLike['chain'] = [{}]): FlatRouteLike {
  return { fullPath, chain }
}

test('root path maps to index.html and is included', () => {
  const [d] = collectStaticPaths([route('/')])
  expect(d.include).toBe(true)
  expect(d.reason).toBeUndefined()
  expect(d.outFile).toBe('index.html')
})

test('nested path maps to <path>/index.html', () => {
  const [d] = collectStaticPaths([route('/docs/intro')])
  expect(d.include).toBe(true)
  expect(d.outFile).toBe('docs/intro/index.html')
})

test('trailing slash maps to the same outFile', () => {
  const [d] = collectStaticPaths([route('/docs/intro/')])
  expect(d.outFile).toBe('docs/intro/index.html')
})

test('trailing-slash duplicates dedupe to one decision', () => {
  const out = collectStaticPaths([route('/docs/intro'), route('/docs/intro/')])
  expect(out.length).toBe(1)
  expect(out[0].outFile).toBe('docs/intro/index.html')
})

test('dynamic {param} segment → excluded with reason dynamic-param', () => {
  const [d] = collectStaticPaths([route('/pokemon/{name}')])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('dynamic-param')
})

test('wildcard segment → excluded with reason wildcard', () => {
  const [d] = collectStaticPaths([route('/files/*')])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('wildcard')
})

test('leaf sse route → excluded with reason sse', () => {
  const [d] = collectStaticPaths([route('/events', [{}, { sse: () => {} }])])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('sse')
})

test('leaf websocket route → excluded with reason websocket', () => {
  const [d] = collectStaticPaths([route('/ws', [{}, { websocket: () => {} }])])
  expect(d.include).toBe(false)
  expect(d.reason).toBe('websocket')
})

test('sse/websocket are checked on the LEAF chain node only', () => {
  // A parent node with sse can't exist in practice (sse routes have no
  // children), but the contract is leaf-only — a non-sse leaf stays included.
  const [d] = collectStaticPaths([route('/docs', [{ sse: () => {} }, {}])])
  expect(d.include).toBe(true)
  expect(d.reason).toBeUndefined()
})

test('output is deterministic — sorted by fullPath regardless of input order', () => {
  const out = collectStaticPaths([route('/z'), route('/'), route('/docs/intro'), route('/a')])
  expect(out.map((d) => d.fullPath)).toEqual(['/', '/a', '/docs/intro', '/z'])
})

test('excluded routes still carry an outFile mapping', () => {
  const [d] = collectStaticPaths([route('/blog/{slug}')])
  expect(d.outFile).toBe('blog/{slug}/index.html')
})

test('navPayloadFileFor mirrors the client fetch URL /_brust/page<path>', () => {
  // bootstrap.ts navigate() fetches `/_brust/page${pathname}` — pathname '/'
  // yields '/_brust/page/', so the root payload must be the directory index.
  expect(navPayloadFileFor('/')).toBe('_brust/page/index.html')
  expect(navPayloadFileFor('/docs/intro')).toBe('_brust/page/docs/intro/index.html')
})

test('outFile decodes percent-encoded segments (static hosts decode before file lookup)', () => {
  const [d] = collectStaticPaths([route('/ssg-blog/sa%20wad-dee')])
  expect(d!.outFile).toBe('ssg-blog/sa wad-dee/index.html')
  expect(navPayloadFileFor('/ssg-blog/sa%20wad-dee')).toBe(
    path.join('_brust', 'page', 'ssg-blog', 'sa wad-dee', 'index.html'),
  )
})

test('malformed percent sequences fall back to the raw segment', () => {
  const [d] = collectStaticPaths([route('/x/100%25-not%2')])
  expect(d!.outFile).toBe('x/100%-not%2/index.html')
})

test('%2F in a segment does NOT create a nested directory', () => {
  const [d] = collectStaticPaths([route('/x/a%2Fb')])
  expect(d!.outFile).toBe('x/a%2Fb/index.html')
})

test('dot segments cannot traverse out of the export dir; expansion rejects them at the source', async () => {
  const [d] = collectStaticPaths([route('/x/%2E%2E/y')])
  expect(d!.outFile).toBe('x/%2E%2E/y/index.html')
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => [{ slug: '..' }] })]),
  ).rejects.toThrow(/not a valid path segment/)
})

// ----- expandDynamicRoutes -----

const ssgRoute = (
  fullPath: string,
  ssg?: Record<string, unknown>,
  leafExtra: Record<string, unknown> = {},
) => ({ fullPath, chain: [{ ...(ssg ? { ssg } : {}), ...leafExtra }] }) as FlatRouteLike

test('expandDynamicRoutes appends concrete entries; pattern stays once in place', async () => {
  const base = [ssgRoute('/blog/{slug}', { params: () => [{ slug: 'a' }, { slug: 'b' }] })]
  const out = await expandDynamicRoutes(base)
  expect(out.map((r) => r.fullPath)).toEqual(['/blog/{slug}', '/blog/a', '/blog/b'])
  expect(out[1]!.chain).toBe(base[0]!.chain)
})

test('expansion URL-encodes values; multi-param patterns substitute every segment', async () => {
  const out = await expandDynamicRoutes([
    ssgRoute('/d/{a}/x/{b}', { params: () => [{ a: 'sa wad-dee', b: 'k/ก' }] }),
  ])
  expect(out[1]!.fullPath).toBe('/d/sa%20wad-dee/x/k%2F%E0%B8%81')
})

test('async params() supported; duplicates deduped', async () => {
  const out = await expandDynamicRoutes([
    ssgRoute('/p/{id}', { params: async () => [{ id: '1' }, { id: '1' }] }),
  ])
  expect(out.map((r) => r.fullPath)).toEqual(['/p/{id}', '/p/1'])
})

test('validation: missing key / empty value / non-array / params throw → Error with pattern', async () => {
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => [{ nope: 'x' }] })]),
  ).rejects.toThrow(/\/b\/\{slug\}.*record #1.*'slug'/)
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => [{ slug: '' }] })]),
  ).rejects.toThrow(/\/b\/\{slug\}/)
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => 'nope' as never })]),
  ).rejects.toThrow(/\/b\/\{slug\}.*array/)
  await expect(
    expandDynamicRoutes([
      ssgRoute('/b/{slug}', {
        params: () => {
          throw new Error('db down')
        },
      }),
    ]),
  ).rejects.toThrow(/\/b\/\{slug\}.*db down/)
})

test('validation: sentinel value rejected; ssg on non-dynamic path rejected; native+fallback:client rejected', async () => {
  await expect(
    expandDynamicRoutes([
      ssgRoute('/b/{slug}', { params: () => [{ slug: '__brust_fallback__' }] }),
    ]),
  ).rejects.toThrow(/__brust_fallback__/)
  await expect(
    expandDynamicRoutes([ssgRoute('/static-page', { params: () => [] })]),
  ).rejects.toThrow(/static-page.*no \{param\}/)
  await expect(
    expandDynamicRoutes([ssgRoute('/n/{x}', { fallback: 'client' }, { native: true })]),
  ).rejects.toThrow(/native/)
})

test('routes without ssg pass through untouched (and dynamic ones stay skippable)', async () => {
  const base = [ssgRoute('/'), ssgRoute('/blog/{slug}')]
  const out = await expandDynamicRoutes(base)
  expect(out).toEqual(base)
})

test('repeated {name} in a pattern validates once and substitutes every occurrence', async () => {
  const out = await expandDynamicRoutes([
    ssgRoute('/x/{id}/y/{id}', { params: () => [{ id: '7' }] }),
  ])
  expect(out[1]!.fullPath).toBe('/x/7/y/7')
})

// ----- fallback chunk helpers (Phase B) -----

test('fallbackDiskPath sanitizes {param} → __param__', () => {
  expect(fallbackDiskPath('/blog/{slug}')).toBe('blog/__slug__')
  expect(fallbackDiskPath('/d/{a}/x/{b}')).toBe('d/__a__/x/__b__')
})

test('fallbackSentinelPath substitutes every param with the sentinel', () => {
  expect(fallbackSentinelPath('/d/{a}/x/{b}')).toBe('/d/__brust_fallback__/x/__brust_fallback__')
})

test('fallbackEntrySource emits the chunk entry module', () => {
  expect(fallbackEntrySource('/abs/components/Post.tsx')).toBe(
    "import C, { clientLoader } from '/abs/components/Post.tsx'\nexport { C as Component, clientLoader }\n",
  )
})

test('hasClientLoaderExport detects the export forms', () => {
  expect(hasClientLoaderExport('export const clientLoader = async () => ({})')).toBe(true)
  expect(hasClientLoaderExport('export async function clientLoader() {}')).toBe(true)
  expect(hasClientLoaderExport('export function clientLoader() {}')).toBe(true)
  expect(hasClientLoaderExport('const clientLoader = 1')).toBe(false)
})

// ----- exportStatic (integration: builds the fixture app, boots the dist) -----

const REPO = path.resolve(import.meta.dir, '..', '..')

function dec(
  fullPath: string,
  include = true,
  reason?: SsgRouteDecision['reason'],
): SsgRouteDecision {
  const d: SsgRouteDecision = {
    fullPath,
    include,
    outFile: fullPath === '/' ? 'index.html' : `${fullPath.slice(1)}/index.html`,
  }
  if (reason) d.reason = reason
  return d
}

/** No process whose command line mentions the dist dir may survive exportStatic
 * — orphaned servers are the known port-race flake class. pgrep exits 1 when
 * nothing matches. */
function distServerAlive(dir: string): boolean {
  return Bun.spawnSync(['pgrep', '-f', dir]).exitCode === 0
}

let distDir: string
let appDir: string // stand-in entryDir carrying public/ (the fixture app has none)
let proj: string // isolated build cwd so .brust mirrors never touch the repo

beforeAll(async () => {
  distDir = await mkdtemp(path.join(tmpdir(), 'brust-ssg-dist-'))
  proj = await mkdtemp(path.join(tmpdir(), 'brust-ssg-proj-'))
  const build = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(
    REPO,
    'tests/fixtures/app/index.ts',
  )} --out-dir ${distDir}`
    .cwd(proj)
    .quiet()
    .nothrow()
  if (build.exitCode !== 0) {
    throw new Error(`fixture build failed:\n${build.stdout}\n${build.stderr}`)
  }
  // react/react-dom stay external in the dist bundle — resolve them from the
  // repo (mirrors tests/cli-build.test.ts).
  symlinkSync(path.join(REPO, 'node_modules'), path.join(distDir, 'node_modules'), 'dir')

  appDir = await mkdtemp(path.join(tmpdir(), 'brust-ssg-app-'))
  await mkdir(path.join(appDir, 'public', 'img'), { recursive: true })
  await writeFile(path.join(appDir, 'public', 'hello.txt'), 'hi')
  await writeFile(path.join(appDir, 'public', 'img', 'a.txt'), 'a')
}, 180_000)

afterAll(async () => {
  for (const d of [distDir, proj, appDir]) {
    if (d) await rm(d, { recursive: true, force: true })
  }
})

test('exportStatic crawls included routes, writes pages + assets, kills the child', async () => {
  const staticOut = path.join(proj, 'static-out')
  const result = await exportStatic({
    distDir,
    entryDir: appDir,
    staticOut,
    routes: [
      dec('/'),
      dec('/store-demo'),
      dec('/blog/{slug}', false, 'dynamic-param'),
      dec('/sse-counter', false, 'sse'),
    ],
  })

  expect([...result.written].sort()).toEqual(['index.html', 'store-demo/index.html'])
  expect([...result.navWritten].sort()).toEqual([
    '_brust/page/index.html',
    '_brust/page/store-demo/index.html',
  ])
  expect(result.skipped.map((s) => s.fullPath).sort()).toEqual(['/blog/{slug}', '/sse-counter'])

  const home = await Bun.file(path.join(staticOut, 'index.html')).text()
  expect(home).toContain('Hello from Brust')
  expect(existsSync(path.join(staticOut, 'store-demo', 'index.html'))).toBe(true)

  // SPA payloads live at the exact URL the client navigator fetches and carry
  // the same {html,title,store} JSON the live server returns.
  const navPayload = JSON.parse(
    await Bun.file(path.join(staticOut, '_brust', 'page', 'store-demo', 'index.html')).text(),
  ) as { html: string; title: string }
  expect(typeof navPayload.html).toBe('string')
  expect(navPayload.html.length).toBeGreaterThan(0)

  // Asset copy preserves the live server's URL shape.
  expect(existsSync(path.join(staticOut, '_brust', 'islands', '_bootstrap.js'))).toBe(true)
  expect(existsSync(path.join(staticOut, '_brust', 'islands', '_islands.js'))).toBe(true)
  expect(existsSync(path.join(staticOut, '_brust', 'css', 'app.css'))).toBe(true)
  // public/ is ROOT-mapped (public/hello.txt → /hello.txt), incl. subdirs.
  expect(await Bun.file(path.join(staticOut, 'hello.txt')).text()).toBe('hi')
  expect(existsSync(path.join(staticOut, 'img', 'a.txt'))).toBe(true)

  expect(distServerAlive(distDir)).toBe(false)
}, 60_000)

test('exportStatic throws on non-200, kills the child, leaves no partial site', async () => {
  const staticOut = path.join(proj, 'static-fail')
  let err: Error | undefined
  try {
    await exportStatic({
      distDir,
      entryDir: appDir,
      staticOut,
      routes: [dec('/'), dec('/no-such-page')],
    })
  } catch (e) {
    err = e as Error
  }

  expect(err).toBeDefined()
  expect(err?.message).toContain('/no-such-page')
  expect(err?.message).toContain('404')
  expect(existsSync(staticOut)).toBe(false) // build fails atomically — no partial site
  expect(distServerAlive(distDir)).toBe(false)
}, 60_000)

test('exportStatic with zero included routes skips the server boot, still copies assets', async () => {
  const staticOut = path.join(proj, 'static-empty')
  const result = await exportStatic({
    distDir,
    entryDir: appDir,
    staticOut,
    routes: [dec('/blog/{slug}', false, 'dynamic-param')],
  })
  expect(result.written).toEqual([])
  expect(result.navWritten).toEqual([])
  expect(result.skipped.length).toBe(1)
  expect(existsSync(path.join(staticOut, '_brust', 'css', 'app.css'))).toBe(true)
  expect(await Bun.file(path.join(staticOut, 'hello.txt')).text()).toBe('hi')
}, 30_000)

test('expanded ssg.params routes export concrete pages + payloads (decoded dirs)', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'brust-ssg-exp-'))
  try {
    const res = await exportStatic({
      distDir,
      entryDir: appDir,
      staticOut: outDir,
      routes: collectStaticPaths(
        await expandDynamicRoutes([
          {
            fullPath: '/ssg-blog/{slug}',
            chain: [{ ssg: { params: () => [{ slug: 'hello' }, { slug: 'sa wad-dee' }] } }],
          },
        ]),
      ),
    })
    expect(res.written).toContain('ssg-blog/hello/index.html')
    expect(res.written).toContain('ssg-blog/sa wad-dee/index.html')
    expect(res.navWritten).toContain(
      path.join('_brust', 'page', 'ssg-blog', 'sa wad-dee', 'index.html'),
    )
    const html = await Bun.file(path.join(outDir, 'ssg-blog', 'sa wad-dee', 'index.html')).text()
    // NOTE: Rust matchit does NOT decode params before the loader sees them —
    // the loader receives the percent-encoded form ('sa%20wad-dee', not 'sa wad-dee').
    // This is a known framework gap: params.slug is URL-encoded at SSG crawl time.
    expect(html).toContain('post:sa%20wad-dee') // encoded — see discrepancy note above
    expect(res.skipped.map((s) => s.fullPath)).toEqual(['/ssg-blog/{slug}'])
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}, 60_000)
