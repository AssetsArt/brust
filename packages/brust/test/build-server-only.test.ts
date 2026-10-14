// F-row island-prop-demotion N2 (Mellow's spec on task hardening-batch): the `server-only` marker package. A browser build
// that reaches it is refused (`server-only-in-client`) whether or not the package throws; the server side resolves it to
// an empty module so a legitimate loader-only use builds and runs.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runBuild } from '../src/build'

const SECRET = 'sk_live_LEAKED_TOKEN_123'
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

type Shape = 'empty' | 'real'
/** An app under test/fixtures (so `@brust/core` and react resolve), with the `server-only` package in one of two shapes:
 * `empty` (what the react-server condition resolves to, or any stub) and `real` (`exports: { react-server: ./empty.js,
 * default: ./index.js }`, where index.js throws, as the published package does). */
function app(name: string, files: Record<string, string>, shape: Shape = 'real'): string {
  const dir = join(import.meta.dir, 'fixtures', `server-only-${name}-${process.pid}`)
  made.push(dir)
  rmSync(dir, { recursive: true, force: true })
  const pkg: Record<string, string> =
    shape === 'empty'
      ? { 'package.json': JSON.stringify({ name: 'server-only', version: '0.0.1', main: 'index.js' }), 'index.js': '' }
      : {
          'package.json': JSON.stringify({ name: 'server-only', version: '0.0.1', exports: { '.': { 'react-server': './empty.js', default: './index.js' } } }),
          'index.js': "throw new Error('This module cannot be imported from a Client Component module. It should only be used from a Server Component.')\n",
          'empty.js': '',
        }
  for (const [f, text] of Object.entries(pkg)) put(join(dir, 'node_modules', 'server-only', f), text)
  for (const [f, text] of Object.entries(files)) put(join(dir, f), text)
  return dir
}
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : [])
const leaked = (dir: string) => walk(join(dir, 'dist')).filter((f) => readFileSync(f).includes(SECRET))
const build = (dir: string) => runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: join(dir, 'dist'), log: () => {}, force: true })
const refusal = async (dir: string) => {
  try {
    await build(dir)
  } catch (e) {
    return e as Error & { rule?: string }
  }
  return undefined
}

const SECRET_TS = `import 'server-only'\nexport const SECRET = '${SECRET}'\nexport function label() { return 'v' + SECRET.length }\n`
const TIP = `import { useReducer } from 'react'\nimport { label } from './lib/secret'\n\nexport default function Tip() {\n  const [n, hit] = useReducer((c: number) => c + 1, 0)\n  return <button type="button" onClick={() => hit()}>{label()}{n}</button>\n}\n`
const PAGE = `import Tip from './Tip'\n\nexport default function Page() {\n  return <main><Tip /></main>\n}\n`
const ROUTES = `import { defineRoutes } from '@brust/core/routes'\nimport Page from './Page'\n\nexport const routes = defineRoutes([{ path: '/', Component: Page }])\n`

test('T1: an island that imports a server-only module is refused, even when the marker package is an empty stub', async () => {
  const dir = app('t1', { 'lib/secret.ts': SECRET_TS, 'Tip.tsx': TIP, 'Page.tsx': PAGE, 'routes.tsx': ROUTES }, 'empty')
  const e = await refusal(dir)
  expect(e?.rule ?? e?.message).toContain('server-only-in-client')
  expect(e?.message).toContain('lib/secret.ts imports server-only')
  expect(leaked(dir)).toEqual([])
  expect(walk(join(dir, 'dist', '.stage')).filter((f) => readFileSync(f).includes(SECRET))).toEqual([])
})

test('T2: with the real (throwing) package the refusal is brust\'s own, not the package\'s throw', async () => {
  const dir = app('t2', { 'lib/secret.ts': SECRET_TS, 'Tip.tsx': TIP, 'Page.tsx': PAGE, 'routes.tsx': ROUTES })
  const e = await refusal(dir)
  expect(e?.message).toContain('lib/secret.ts imports server-only')
  expect(e?.message).not.toContain('cannot be imported from a Client Component')
  expect(leaked(dir)).toEqual([])
})

test('T4: transitive, island -> lib/a.ts -> lib/secret.ts names the module that imports server-only', async () => {
  const dir = app('t4', {
    'lib/secret.ts': SECRET_TS,
    'lib/a.ts': `import { label } from './secret'\nexport const a = () => label()\n`,
    'Tip.tsx': TIP.replace("'./lib/secret'", "'./lib/a'").replace('label()', 'a()').replace('{ label }', '{ a }'),
    'Page.tsx': PAGE,
    'routes.tsx': ROUTES,
  })
  const e = await refusal(dir)
  expect(e?.message).toContain('lib/secret.ts imports server-only')
  expect(leaked(dir)).toEqual([])
})

const LOADER_ROUTES = `import { defineRoutes } from '@brust/core/routes'\nimport { SECRET } from './lib/secret'\nimport Page from './Page'\n\nexport const routes = defineRoutes([{ path: '/', Component: Page, loader: async () => ({ len: SECRET.length }) }])\n`
const LOADER_PAGE = `export default function Page({ len }: { len: number }) {\n  return <p data-testid="len">len={len}</p>\n}\n`

test('T3: a legitimate loader-only use of server-only builds with the real package and serves the value', async () => {
  const dir = app('t3', { 'lib/secret.ts': SECRET_TS, 'Page.tsx': LOADER_PAGE, 'routes.tsx': LOADER_ROUTES })
  await build(dir)
  expect(leaked(dir)).toEqual([])
  const port = 18470 + (process.pid % 200)
  const p = Bun.spawn([process.execPath, CLI, 'start', '--port', String(port), '--workers', '1'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  try {
    let html = ''
    for (let i = 0; i < 40 && !html; i++) {
      await Bun.sleep(250)
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`)
        if (r.ok) html = await r.text()
      } catch {}
    }
    expect(html).toContain('len=')
    expect(html).toContain(`${SECRET.length}`)
    expect(html).not.toContain(SECRET)
  } finally {
    p.kill()
    await p.exited
  }
}, 60000)

test('T6: a static page whose server-side job reads the module builds and ships nothing secret to the browser', async () => {
  const dir = app('t6', {
    'lib/secret.ts': SECRET_TS,
    'Page.tsx': `import { label } from './lib/secret'\n\nexport default function Page() {\n  return <p>{label()}</p>\n}\n`,
    'routes.tsx': ROUTES,
  })
  await build(dir)
  expect(leaked(join(dir, 'dist', 'client').replace(/dist\/client$/, '')).filter((f) => f.includes('/client/'))).toEqual([])
})

const FIX = join(import.meta.dir, 'fixtures')
function brustCf(cwd: string, args: string[]) {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, env: { ...process.env, BRUST_CORE_CF_DIR: join(FIX, 'cf-core') }, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

test('T5: the Cloudflare target refuses the island import, and a loader-only use builds the Worker', () => {
  const bad = app('t5a', { 'lib/secret.ts': SECRET_TS, 'Tip.tsx': TIP, 'Page.tsx': PAGE, 'routes.tsx': ROUTES })
  const r1 = brustCf(bad, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', join(bad, 'dist')])
  expect(r1.code).not.toBe(0)
  expect(r1.err).toContain('lib/secret.ts imports server-only')
  expect(r1.err).not.toContain('cannot be imported from a Client Component')
  expect(leaked(bad)).toEqual([])
  const ok = app('t5b', { 'lib/secret.ts': SECRET_TS, 'Page.tsx': LOADER_PAGE, 'routes.tsx': LOADER_ROUTES })
  const r2 = brustCf(ok, ['build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', join(ok, 'dist')])
  expect(r2.err).not.toContain('cannot be imported from a Client Component')
  expect(r2.code).toBe(0)
  // The Worker is server code: it may carry the value, the browser assets may not.
  expect(leaked(join(ok, 'dist', 'cf', 'assets').replace(/\/cf\/assets$/, '')).filter((f) => f.includes('/assets/'))).toEqual([])
}, 120000)
