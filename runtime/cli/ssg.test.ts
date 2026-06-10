import { test, expect, beforeAll, afterAll } from 'bun:test'
import { $ } from 'bun'
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  collectStaticPaths,
  exportStatic,
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
  expect(result.skipped.map((s) => s.fullPath).sort()).toEqual(['/blog/{slug}', '/sse-counter'])

  const home = await Bun.file(path.join(staticOut, 'index.html')).text()
  expect(home).toContain('Hello from Brust')
  expect(existsSync(path.join(staticOut, 'store-demo', 'index.html'))).toBe(true)

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
  expect(result.skipped.length).toBe(1)
  expect(existsSync(path.join(staticOut, '_brust', 'css', 'app.css'))).toBe(true)
  expect(await Bun.file(path.join(staticOut, 'hello.txt')).text()).toBe('hi')
}, 30_000)
