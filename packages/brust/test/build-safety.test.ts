// `brust build` safety rules (m2c review): server-only code never reaches a browser bundle, the
// package root is browser-safe, routes are validated however they are exported, `--out-dir` can
// neither delete the app nor half-replace a good dist, client_only islands mount (not hydrate),
// duplicate patterns fail the build, native chunks share modules.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeOutDir, runBuild } from '../src/build'

const safety = join(import.meta.dir, 'fixtures/safety')
const bin = join(import.meta.dir, '../bin/brust')
const outs: string[] = []
const tmpOut = () => {
  const d = mkdtempSync(join(tmpdir(), 'brust-safety-'))
  outs.push(d)
  return d
}
/** An out dir inside the package: its `jobs.js` (React external) resolves `react` when imported. */
const localOut = () => {
  const d = mkdtempSync(join(import.meta.dir, '.tmp-out-'))
  outs.push(d)
  return d
}
afterAll(() => {
  for (const d of outs) rmSync(d, { recursive: true, force: true })
})

const build = (dir: string, outDir: string, entry = 'routes.tsx') => runBuild({ appRoot: dir, entry, outDir, log: () => {} })
const cli = (args: string[], cwd: string) => {
  const p = Bun.spawnSync([bin, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const clientFiles = (out: string) => readdirSync(join(out, 'client')).map((f) => join(out, 'client', f))

// ---- 1. server-only code never reaches a browser bundle ----

test('a native component reaching node:fs through a helper module fails with server-only-in-client', async () => {
  const out = tmpOut()
  const r = cli(['build', 'routes.tsx', '--out-dir', out], join(safety, 'so-native'))
  expect(r.code).toBe(1)
  expect(r.err).toContain('error server-only-in-client')
  expect(r.err).toContain('secrets.ts imports node:fs')
  expect(existsSync(join(out, 'manifest.json'))).toBe(false)
}, 60_000)

test('a react island importing ./x.server.ts fails with server-only-in-client', async () => {
  const out = tmpOut()
  const r = cli(['build', 'routes.tsx', '--out-dir', out], join(safety, 'so-react'))
  expect(r.code).toBe(1)
  expect(r.err).toContain('error server-only-in-client')
  expect(r.err).toContain('Counter.tsx imports ./db.server')
}, 60_000)

test('brust.toml [build] server_only reaches both the compiler (native) and the browser bundle (react)', async () => {
  const dir = join(safety, 'so-config')
  await expect(build(dir, tmpOut(), 'routes-native.tsx')).rejects.toMatchObject({ rule: 'server-only-in-client' })
  await expect(build(dir, tmpOut(), 'routes-react.tsx')).rejects.toMatchObject({
    rule: 'server-only-in-client',
    message: expect.stringContaining('Island.tsx imports ./lib/server/db'),
  })
}, 60_000)

test('server-only code used only by a loader and a precompute job still builds; client output has none of it', async () => {
  const out = localOut()
  await build(join(safety, 'so-ok'), out)
  for (const f of clientFiles(out)) expect(readFileSync(f, 'utf8')).not.toContain('existsSync')
  const jobs = (await import(join(out, 'jobs.js'))).default
  const page = Object.keys(jobs).find((k) => k.startsWith('page_'))!
  expect(jobs[page].precompute({ name: 'x' })).toEqual({ _s1: 'x:fs' })
}, 60_000)

test('server-only checks apply to the RESOLVED file: tsconfig paths aliases cannot bypass them', async () => {
  const dir = join(safety, 'so-alias')
  for (const [entry, spec] of [
    ['routes-db.tsx', '@db'], // alias of lib/server/db.ts ([build] server_only "lib/server")
    ['routes-sec.tsx', '@sec'], // alias of lib/secret.server.ts (*.server.*)
  ] as const) {
    const out = tmpOut()
    const r = cli(['build', entry, '--out-dir', out], dir)
    expect(r.code).toBe(1)
    expect(r.err).toContain('error server-only-in-client')
    expect(r.err).toContain(`Island.tsx imports ${spec}`)
    expect(existsSync(join(out, 'manifest.json'))).toBe(false)
  }
  // An alias to a browser-safe module still builds.
  const out = tmpOut()
  await build(dir, out, 'routes-ok.tsx')
  expect(clientFiles(out).some((f) => readFileSync(f, 'utf8').includes('hello'))).toBe(true)
}, 60_000)

/** A throwaway react app inside the package importing `spec`, with a stub npm package `pkg`. */
function polyfillApp(pkg: string, spec: string, use: string): string {
  const dir = mkdtempSync(join(import.meta.dir, '.tmp-poly-'))
  outs.push(dir)
  mkdirSync(join(dir, 'node_modules', pkg), { recursive: true })
  writeFileSync(join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', pkg, 'index.js'), 'export const readFileSync = () => "", EventEmitter = class {}\n')
  writeFileSync(
    join(dir, 'Island.tsx'),
    `import { ${use} } from '${spec}'\nimport { useReducer } from 'react'\nexport default function Island() {\n  const [n, bump] = useReducer((x: number) => x + 1, 0)\n  return <b onClick={bump} title={String(${use})}>{n}</b>\n}\n`,
  )
  writeFileSync(join(dir, 'routes.tsx'), "import Island from './Island'\nexport const routes = [{ path: '/', Component: Island }]\n")
  return dir
}

test('an installed npm package named like a builtin unlocks only allowlisted browser polyfills', async () => {
  // A placeholder `fs` package must not let `import { readFileSync } from 'fs'` into the browser.
  const fs = cli(['build', 'routes.tsx', '--out-dir', tmpOut()], polyfillApp('fs', 'fs', 'readFileSync'))
  expect(fs.code).toBe(1)
  expect(fs.err).toContain('error server-only-in-client')
  expect(fs.err).toContain('Island.tsx imports fs')
  // `events` is a real browser polyfill: installed, it builds.
  const ev = cli(['build', 'routes.tsx', '--out-dir', tmpOut()], polyfillApp('events', 'events', 'EventEmitter'))
  expect(ev.err).toBe('')
  expect(ev.code).toBe(0)
}, 60_000)

// ---- 2. browser-safe `@brust/brust` ----

test('a react island importing { cache } from @brust/brust builds, with no addon in its chunks', async () => {
  const out = tmpOut()
  await build(join(safety, 'react-cache'), out)
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  const counter = Object.keys(m.components).find((k) => k.startsWith('counter_'))!
  expect(m.components[counter].client).toMatch(/^client\/react-counter_/)
  for (const f of clientFiles(out)) {
    const js = readFileSync(f, 'utf8')
    expect(js).not.toMatch(/\.node["']|native\/index|startServer|registerWorker|loadConfig/)
  }
}, 60_000)

// ---- 3. the route validator runs on whatever the entry exports ----

test('a plain exported route array is validated (field, ttl, bypass, layout cache)', async () => {
  const dir = join(safety, 'routes-invalid')
  for (const [entry, msg] of [
    ['field.tsx', 'meta is not supported in M2 (M3)'],
    ['ttl.tsx', 'cache.ttl_seconds must be a non-negative integer'],
    ['bypass.tsx', 'cache.bypass must be true or a string'],
    ['layout-cache.tsx', 'cache on a layout route is not supported'],
  ] as const) {
    const out = tmpOut()
    await expect(build(dir, out, entry)).rejects.toMatchObject({ rule: 'route-config', message: expect.stringContaining(msg) })
    expect(existsSync(join(out, 'manifest.json'))).toBe(false)
  }
  const r = cli(['build', 'ttl.tsx', '--out-dir', tmpOut()], dir)
  expect(r.code).toBe(1)
  expect(r.err).toContain('error route-config')
}, 60_000)

// ---- 4. --out-dir safety ----

/** A throwaway app inside the package (so `react` resolves) that a bad --out-dir could delete,
 * one level inside its own sandbox dir (so `..` is the sandbox, never `test/`). */
function throwawayApp(): string {
  const sandbox = mkdtempSync(join(import.meta.dir, '.tmp-app-'))
  outs.push(sandbox)
  const dir = join(sandbox, 'app')
  mkdirSync(dir)
  cpSync(join(safety, 'routes-invalid/Home.tsx'), join(dir, 'Home.tsx'))
  writeFileSync(join(dir, 'routes.tsx'), "import Home from './Home'\nexport const routes = [{ path: '/', Component: Home }]\n")
  return dir
}

test('--out-dir that is or contains the app is refused (out-dir-unsafe), sources intact', () => {
  const dir = throwawayApp()
  for (const o of ['.', '..']) {
    const r = cli(['build', 'routes.tsx', '--out-dir', o], dir)
    expect(r.code).toBe(1)
    expect(r.err).toContain('error out-dir-unsafe')
    expect(existsSync(join(dir, 'routes.tsx'))).toBe(true)
    expect(existsSync(join(dir, 'Home.tsx'))).toBe(true)
  }
  // Never run against the real root / home: the guard alone.
  for (const o of ['/', homedir(), join(dir, 'routes.tsx'), dir])
    expect(() => assertSafeOutDir(o, dir, [join(dir, 'routes.tsx')])).toThrow(expect.objectContaining({ rule: 'out-dir-unsafe' }))
  expect(() => assertSafeOutDir(join(dir, 'dist'), dir, [join(dir, 'routes.tsx')])).not.toThrow()
  // A dir holding a route Component (not the entry) is refused too.
  mkdirSync(join(dir, 'src'))
  cpSync(join(dir, 'Home.tsx'), join(dir, 'src/Home.tsx'))
  writeFileSync(join(dir, 'routes-src.tsx'), "import Home from './src/Home'\nexport const routes = [{ path: '/', Component: Home }]\n")
  const src = cli(['build', 'routes-src.tsx', '--out-dir', 'src'], dir)
  expect(src.code).toBe(1)
  expect(src.err).toContain('error out-dir-unsafe')
  expect(existsSync(join(dir, 'src/Home.tsx'))).toBe(true)
  // The happy path still works from the same app.
  const ok = cli(['build', 'routes.tsx'], dir)
  expect(ok.code).toBe(0)
  expect(existsSync(join(dir, 'dist/manifest.json'))).toBe(true)
}, 60_000)

test('a non-empty out dir that is not a previous brust dist is refused unless --force', () => {
  const dir = throwawayApp()
  // A helper dir (no route Component in it) and a .git-like dir.
  mkdirSync(join(dir, 'lib'))
  writeFileSync(join(dir, 'lib', 'helper.ts'), 'export const x = 1\n')
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  for (const o of ['lib', '.git']) {
    const r = cli(['build', 'routes.tsx', '--out-dir', o], dir)
    expect(r.code).toBe(1)
    expect(r.err).toContain('error out-dir-unsafe')
    expect(r.err).toContain('--force')
  }
  expect(readFileSync(join(dir, 'lib', 'helper.ts'), 'utf8')).toBe('export const x = 1\n')
  expect(readFileSync(join(dir, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
  // Round 4 (r3src repro): an unrelated manifest.json is NOT a previous brust build — only the
  // `.brust` marker unlocks the wipe, so util.ts next to it survives.
  mkdirSync(join(dir, 'r3src'))
  writeFileSync(join(dir, 'r3src', 'manifest.json'), '{}\n')
  writeFileSync(join(dir, 'r3src', 'util.ts'), 'export const x=1\n')
  const r3 = cli(['build', 'routes.tsx', '--out-dir', 'r3src'], dir)
  expect(r3.code).toBe(1)
  expect(r3.err).toContain('error out-dir-unsafe')
  expect(readFileSync(join(dir, 'r3src', 'util.ts'), 'utf8')).toBe('export const x=1\n')
  expect(readFileSync(join(dir, 'r3src', 'manifest.json'), 'utf8')).toBe('{}\n')
  // A nonexistent dir builds and gets the marker; a previous (marked) dist is replaced.
  expect(cli(['build', 'routes.tsx', '--out-dir', 'out'], dir).code).toBe(0)
  expect(existsSync(join(dir, 'out', '.brust'))).toBe(true)
  writeFileSync(join(dir, 'out', 'stale.txt'), 'x')
  expect(cli(['build', 'routes.tsx', '--out-dir', 'out'], dir).code).toBe(0)
  expect(existsSync(join(dir, 'out', 'stale.txt'))).toBe(false)
  // An empty dir builds.
  mkdirSync(join(dir, 'empty'))
  expect(cli(['build', 'routes.tsx', '--out-dir', 'empty'], dir).code).toBe(0)
  // --force replaces an unmarked dir.
  const forced = cli(['build', 'routes.tsx', '--out-dir', 'lib', '--force'], dir)
  expect(forced.err).toBe('')
  expect(forced.code).toBe(0)
  expect(existsSync(join(dir, 'lib', 'helper.ts'))).toBe(false)
  expect(existsSync(join(dir, 'lib', 'manifest.json'))).toBe(true)
}, 60_000)

test('a failing build leaves the previous dist untouched', async () => {
  const out = tmpOut()
  mkdirSync(join(out, 'client'), { recursive: true })
  writeFileSync(join(out, 'manifest.json'), '{"old":true}')
  writeFileSync(join(out, '.brust'), '')
  writeFileSync(join(out, 'client', 'keep-0123456789.js'), '1')
  await expect(build(join(safety, 'routes-invalid'), out, 'ttl.tsx')).rejects.toMatchObject({ rule: 'route-config' })
  await expect(build(join(safety, 'so-native'), out)).rejects.toMatchObject({ rule: 'server-only-in-client' })
  expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe('{"old":true}')
  expect(existsSync(join(out, 'client', 'keep-0123456789.js'))).toBe(true)
  // A successful build then replaces it whole.
  await build(join(safety, 'shared-store'), out)
  expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).version).toBe(1)
  expect(existsSync(join(out, 'client', 'keep-0123456789.js'))).toBe(false)
  expect(readdirSync(join(out, '..')).filter((f) => f.startsWith(`.${out.split('/').pop()}`))).toEqual([])
}, 60_000)

// ---- 5. client_only islands mount with createRoot, the rest hydrate ----

test('a client_only island mounts into its empty host (no #418); a server-rendered island hydrates in place', async () => {
  const out = tmpOut()
  await build(join(import.meta.dir, 'fixtures/shapes'), out)
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  const id = (p: string) => Object.keys(m.components).find((k) => k.startsWith(p))!
  const [clock, badge] = [id('clock_'), id('badge_')]
  const p = Bun.spawnSync(
    [
      'bun',
      join(import.meta.dir, 'helpers/mount-islands.ts'),
      JSON.stringify([
        { chunk: join(out, m.components[clock].client), id: clock, html: '' },
        { chunk: join(out, m.components[badge].client), id: badge, html: '<b>Ann<!-- -->:<!-- -->0</b>', props: { label: 'Ann' } },
      ]),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  expect(p.stderr.toString()).toBe('')
  const res = JSON.parse(p.stdout.toString())
  expect(res.errors).toEqual([])
  expect(res.islands[0].html).toMatch(/^<time>\d+<\/time>$/)
  expect(res.islands[1]).toEqual({ html: '<b>Ann<!-- -->:<!-- -->0</b>', sameNode: true })
}, 60_000)

// ---- 6. duplicate route patterns ----

test('duplicate route patterns (trailing slash, param names) fail with duplicate-route', async () => {
  const dir = join(safety, 'routes-invalid')
  await expect(build(dir, tmpOut(), 'dup-slash.tsx')).rejects.toMatchObject({ rule: 'duplicate-route', message: expect.stringContaining('/a') })
  await expect(build(dir, tmpOut(), 'dup-plain.tsx')).rejects.toMatchObject({ rule: 'duplicate-route', message: expect.stringContaining('/b/{') })
}, 60_000)

// ---- 7. native client chunks share modules ----

test('two native components importing the same store ship one copy of it', async () => {
  const out = tmpOut()
  await build(join(safety, 'shared-store'), out)
  const withStore = clientFiles(out).filter((f) => readFileSync(f, 'utf8').includes('hits'))
  expect(withStore.length).toBe(1)
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  // Every relative import between chunks names a file that exists (hashed rename rewrote it).
  for (const f of clientFiles(out))
    for (const [, rel] of readFileSync(f, 'utf8').matchAll(/from\s*"\.\/([^"]+)"/g)) expect(existsSync(join(out, 'client', rel!))).toBe(true)
  for (const c of Object.values(m.components) as { client: string | null }[]) if (c.client) expect(existsSync(join(out, c.client))).toBe(true)
}, 60_000)
