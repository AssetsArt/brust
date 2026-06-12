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
  fallback404Html,
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

test('fallbackEntrySource emits the chunk entry module (JSON-quoted specifier)', () => {
  expect(fallbackEntrySource('/abs/components/Post.tsx')).toBe(
    'import C, { clientLoader } from "/abs/components/Post.tsx"\nexport { C as Component, clientLoader }\n',
  )
  // A quote in the path cannot break the generated module syntax.
  expect(fallbackEntrySource("/a/it's/Post.tsx")).toContain('"/a/it\'s/Post.tsx"')
})

test('hasClientLoaderExport detects the export forms', () => {
  expect(hasClientLoaderExport('export const clientLoader = async () => ({})')).toBe(true)
  expect(hasClientLoaderExport('export async function clientLoader() {}')).toBe(true)
  expect(hasClientLoaderExport('export function clientLoader() {}')).toBe(true)
  expect(hasClientLoaderExport('export let clientLoader = async () => ({})')).toBe(true)
  expect(hasClientLoaderExport('const clientLoader = 1\nexport { clientLoader }')).toBe(true)
  expect(hasClientLoaderExport('const x = 1\nexport { x as clientLoader }')).toBe(true)
  expect(hasClientLoaderExport('// export const clientLoader = async () => ({})')).toBe(false)
  expect(hasClientLoaderExport('/* export const clientLoader = 1 */')).toBe(false)
  expect(hasClientLoaderExport('const clientLoader = 1')).toBe(false)
})

// ----- fallback404Html (Phase B, pure) -----

test('fallback404Html inlines the pattern/doc pairs and the redirect script', () => {
  const html = fallback404Html([
    { pattern: '/ssg-fb/{slug}', doc: '/_brust/fallback/ssg-fb/__slug__/' },
  ])
  expect(html).toContain('/ssg-fb/{slug}')
  expect(html).toContain('/_brust/fallback/ssg-fb/__slug__/')
  expect(html).toContain("sessionStorage.setItem('brust:fallback-path'")
  expect(html).toContain('location.replace')
  expect(html).toContain('Not found.')
})

test('fallback404Html escapes </script> + U+2028/29 in the inlined JSON (script-context guard)', () => {
  const html = fallback404Html([{ pattern: '/x/{a}</script>', doc: '/d/ ' }])
  expect(html).toContain('\\u003c/script\\u003e')
  expect(html).toContain('\\u2028')
  expect(html).not.toContain(' ')
  // the only raw </script> left is the document's own closing tag
  expect(html.match(/<\/script>/g)?.length).toBe(1)
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

test('fallback emission: shell doc + payload + routes.json manifest + 404.html', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'brust-ssg-fb-'))
  try {
    const res = await exportStatic({
      distDir,
      entryDir: appDir,
      staticOut: outDir,
      routes: collectStaticPaths(
        await expandDynamicRoutes([
          {
            fullPath: '/ssg-fb/{slug}',
            chain: [{ ssg: { params: () => [{ slug: 'pre' }], fallback: 'client' } }],
          },
        ]),
      ),
      fallbacks: [{ pattern: '/ssg-fb/{slug}', chunk: '/_brust/islands/Fallback_test.js' }],
    })

    // Prerendered param page: real loader data, NO fallback marker.
    const pre = await Bun.file(path.join(outDir, 'ssg-fb', 'pre', 'index.html')).text()
    expect(pre).toContain('srv:pre')
    expect(pre).not.toContain('data-brust-fallback-root')

    // Fallback shell document: sentinel render with the takeover mount point
    // and the islands bootstrap FORCED in (the shell itself has zero islands).
    const doc = await Bun.file(
      path.join(outDir, '_brust', 'fallback', 'ssg-fb', '__slug__', 'index.html'),
    ).text()
    expect(doc).toContain('data-brust-fallback-root')
    expect(doc).toContain('_bootstrap.js')

    // Fallback SPA payload: same {html,...} JSON contract as nav payloads.
    const payload = JSON.parse(
      await Bun.file(
        path.join(outDir, '_brust', 'fallback-page', 'ssg-fb', '__slug__', 'index.html'),
      ).text(),
    ) as { html: string }
    expect(typeof payload.html).toBe('string')
    expect(payload.html).toContain('data-brust-fallback-root')

    // Manifest: doc/payload are directory-index URLs; chunk passes through verbatim.
    const manifest = JSON.parse(
      await Bun.file(path.join(outDir, '_brust', 'routes.json')).text(),
    ) as unknown
    expect(manifest).toEqual({
      version: 1,
      fallbacks: [
        {
          pattern: '/ssg-fb/{slug}',
          doc: '/_brust/fallback/ssg-fb/__slug__/',
          payload: '/_brust/fallback-page/ssg-fb/__slug__/',
          chunk: '/_brust/islands/Fallback_test.js',
        },
      ],
    })

    // 404.html carries the inlined pattern for the client-side redirect.
    const notFound = await Bun.file(path.join(outDir, '404.html')).text()
    expect(notFound).toContain('/ssg-fb/{slug}')

    // ASCII sort: '-' (0x2D) < '/' (0x2F), so fallback-page/ precedes fallback/.
    expect([...res.fallbackWritten].sort()).toEqual([
      path.join('_brust', 'fallback-page', 'ssg-fb', '__slug__', 'index.html'),
      path.join('_brust', 'fallback', 'ssg-fb', '__slug__', 'index.html'),
    ])
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}, 60_000)

// ----- full-CLI e2e: brust build --ssg with fallback routes -----
//
// The only test that exercises the REAL CLI pipeline end-to-end — fallback
// chunk build (build.ts step 7.5) + crawl + shell/payload/manifest/404
// emission in one `brust build --ssg` run. A blanket --ssg crawl of the FULL
// fixture app fails BY DESIGN (auth-gated /admin/users → 401 → exportStatic
// no-partial throw), so this builds a minimal app in a tmp project instead:
// '/', the fallback route, and its clientLoader data endpoint. The component
// file is copied verbatim from the fixture so the two stay in sync.
test('brust build --ssg emits fallback chunk + shells + manifest + 404 for fallback routes', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'brust-ssg-cli-proj-'))
  const out = await mkdtemp(path.join(tmpdir(), 'brust-ssg-cli-out-'))
  try {
    // react/react-dom stay external — resolve them from the repo, both at
    // build time (proj sources) and when the ssg crawl boots the dist
    // (resolution walks UP from out/dist; the build wipes --out-dir itself,
    // so the symlink must live one level above it or it gets deleted before
    // the crawl boots).
    symlinkSync(path.join(REPO, 'node_modules'), path.join(proj, 'node_modules'), 'dir')
    symlinkSync(path.join(REPO, 'node_modules'), path.join(out, 'node_modules'), 'dir')

    await mkdir(path.join(proj, 'components'), { recursive: true })
    await Bun.write(
      path.join(proj, 'components', 'SsgFallbackPost.tsx'),
      Bun.file(path.join(REPO, 'tests/fixtures/app/components/SsgFallbackPost.tsx')),
    )
    await writeFile(
      path.join(proj, 'components', 'Home.tsx'),
      'export default function Home() {\n  return <h1>cli-e2e home</h1>\n}\n',
    )
    await writeFile(
      path.join(proj, 'routes.tsx'),
      `import { defineRoutes, type Middleware } from ${JSON.stringify(
        path.join(REPO, 'runtime/routes.ts'),
      )}
import Home from './components/Home'
import SsgFallbackPost from './components/SsgFallbackPost'

// JSON GET endpoint for the clientLoader — middleware short-circuit, mirrors
// tests/fixtures/app/routes.tsx.
const ssgFallbackData: Middleware = async (req, _next) => {
  const slug = decodeURIComponent((req.url.split('?')[0] ?? '').split('/').pop() ?? '')
  return {
    status: 200,
    body: JSON.stringify({ title: \`client:\${slug}\` }),
    contentType: 'application/json; charset=utf-8',
  }
}

export const routes = defineRoutes([
  { path: '/', Component: Home },
  {
    path: '/ssg-fb/{slug}',
    Component: SsgFallbackPost,
    loader: async ({ params }) => ({ title: \`srv:\${params.slug}\` }),
    ssg: { params: () => [{ slug: 'pre' }], fallback: 'client' },
  },
  {
    path: '/api/ssg-fallback-data/{slug}',
    Component: SsgFallbackPost,
    middleware: [ssgFallbackData],
  },
])
`,
    )
    await writeFile(
      path.join(proj, 'index.ts'),
      `import { brust } from ${JSON.stringify(path.join(REPO, 'runtime/index.ts'))}
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url })
`,
    )

    const distDir = path.join(out, 'dist')
    const staticDir = path.join(out, 'static')
    const build = await $`bun ${path.join(
      REPO,
      'runtime/cli/index.ts',
    )} build ${path.join(proj, 'index.ts')} --out-dir ${distDir} --ssg --ssg-out ${staticDir}`
      .cwd(proj)
      .quiet()
      .nothrow()
    const stdout = build.stdout.toString()
    if (build.exitCode !== 0) {
      throw new Error(`brust build --ssg failed:\n${stdout}\n${build.stderr.toString()}`)
    }

    // Prerendered param page — real loader data, NO fallback marker.
    const pre = await Bun.file(path.join(staticDir, 'ssg-fb', 'pre', 'index.html')).text()
    expect(pre).toContain('srv:pre')
    expect(pre).not.toContain('data-brust-fallback-root')

    // Fallback shell document + SPA payload.
    const shell = await Bun.file(
      path.join(staticDir, '_brust', 'fallback', 'ssg-fb', '__slug__', 'index.html'),
    ).text()
    expect(shell).toContain('data-brust-fallback-root')
    expect(shell).toContain('_bootstrap.js')
    // The islands RUNTIME files must exist even though this app has ZERO
    // islands — the shell's script tag above would otherwise 404 and the
    // takeover never runs (regression: the islands build used to be skipped
    // entirely without <Island> usage).
    for (const f of ['_bootstrap.js', '_react.js', '_react-dom.js']) {
      expect(existsSync(path.join(staticDir, '_brust', 'islands', f))).toBe(true)
    }
    const payload = JSON.parse(
      await Bun.file(
        path.join(staticDir, '_brust', 'fallback-page', 'ssg-fb', '__slug__', 'index.html'),
      ).text(),
    ) as { html: string }
    expect(payload.html).toContain('data-brust-fallback-root')

    // Manifest — the REAL step-7.5 chunk (content-hashed filename; assert via
    // the manifest value, never a hardcoded name).
    const manifest = JSON.parse(
      await Bun.file(path.join(staticDir, '_brust', 'routes.json')).text(),
    ) as { fallbacks: { pattern: string; chunk: string }[] }
    expect(manifest.fallbacks[0]!.pattern).toBe('/ssg-fb/{slug}')
    const chunk = manifest.fallbacks[0]!.chunk
    expect(existsSync(path.join(staticDir, '_brust', 'islands', path.basename(chunk)))).toBe(true)

    // 404.html inlines the pattern (JSON-quoted) for the client-side redirect.
    const notFound = await Bun.file(path.join(staticDir, '404.html')).text()
    expect(notFound).toContain('"/ssg-fb/{slug}"')

    expect(stdout).toContain('fallback chunk')
  } finally {
    await rm(proj, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
}, 240_000)

test('no fallbacks → NO routes.json, NO 404.html (byte-identical-today invariant)', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'brust-ssg-nofb-'))
  try {
    const res = await exportStatic({
      distDir,
      entryDir: appDir,
      staticOut: outDir,
      routes: [dec('/blog/{slug}', false, 'dynamic-param')],
    })
    expect(res.fallbackWritten).toEqual([])
    expect(existsSync(path.join(outDir, '_brust', 'routes.json'))).toBe(false)
    expect(existsSync(path.join(outDir, '404.html'))).toBe(false)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}, 30_000)
