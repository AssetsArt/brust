// F218 + F221-F224 (pkg-src-dist-islands review follow-ups): the package resolver probe is bounded and runs from the app
// root, names its fallback, carries every build target's own conditions, keeps its answers across builds, and the
// directory specifiers `.` / `..` are resolved on the same path as `./x`.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PRODUCTION, sourceDirPlugin } from '../src/build/bundle'
import { CF_CONDITIONS } from '../src/build/cloudflare'
import { clearResolveCache, resolveNative } from '../src/build/esm-resolve'

const cleanup: string[] = []
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-rf-')))
  cleanup.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const pkg = (root: string, name: string, pj: object, files: Record<string, string>) => {
  put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...pj }))
  for (const [f, t] of Object.entries(files)) put(join(root, 'node_modules', name, f), t)
}

// F221 timeout: a probe that does not answer is killed, and the build goes on with the runtime answer.
test('F221/F222: a probe past its timeout is killed and the fallback is named', () => {
  const root = tmp()
  pkg(root, 'slow', { main: 'main.js' }, { 'main.js': '' })
  const warnings: string[] = []
  clearResolveCache()
  const got = resolveNative('slow', root, 'bun', PRODUCTION, { timeoutMs: 1, warn: (m) => warnings.push(m) })
  expect(got).toBe(join(root, 'node_modules/slow/main.js'))
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('slow')
  expect(warnings[0]).toContain('did not answer within 1 ms')
  expect(warnings[0]).toContain('Bun.resolveSync')
  // Asked again, the same fallback is not re-reported (a build asks per importer).

  resolveNative('slow', root, 'bun', PRODUCTION, { timeoutMs: 1, warn: (m) => warnings.push(m) })
  expect(warnings).toHaveLength(1)
})

test('F221: the probe runs from the app root, not from the package directory', () => {
  const root = tmp()
  pkg(root, 'cwdpkg', { main: 'main.js' }, { 'main.js': '' })
  // `bunfig.toml` is read from the working directory: its preload records where the probe ran.
  const marker = join(root, 'cwd.txt')
  put(join(root, 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
  put(join(root, 'preload.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, process.cwd())\n`)
  clearResolveCache()
  resolveNative('cwdpkg', join(root, 'node_modules/cwdpkg'), 'bun', PRODUCTION, { appRoot: root })
  expect(readFileSync(marker, 'utf8')).toBe(root)
})

test('F222: the probe finding nothing is named, an unresolvable specifier still throws', () => {
  const root = tmp()
  const warnings: string[] = []
  clearResolveCache()
  expect(() => resolveNative('not-installed', root, 'bun', PRODUCTION, { warn: (m) => warnings.push(m) })).toThrow()
  expect(warnings).toEqual([])
  // A package with no entry file: Bun's own resolver reports it, so no silent answer either.
  pkg(root, 'empty', {}, {})
  expect(() => resolveNative('empty', root, 'bun', PRODUCTION, { warn: (m) => warnings.push(m) })).toThrow()
})

// F223: every build target resolves with its own target, conditions and define.
const LAYOUT = {
  exports: { workerd: './workerd.js', worker: './worker.js', browser: './browser.js', node: './node.js', development: './dev.js', import: './import.js', default: './default.js' },
}
const FILES = Object.fromEntries(['workerd', 'worker', 'browser', 'node', 'dev', 'import', 'default'].map((n) => [`${n}.js`, '']))
const TARGETS = [
  { name: 'bun (jobs, build-eval; static server side)', target: 'bun', conditions: undefined },
  { name: 'browser (islands; static client)', target: 'browser', conditions: undefined },
  { name: 'cloudflare (Worker bundle)', target: 'browser', conditions: CF_CONDITIONS },
] as const

async function bundlerPick(root: string, spec: string, t: (typeof TARGETS)[number], define: Record<string, string>): Promise<string> {
  const f = join(root, `real-${t.target}-${t.conditions ? 'cf' : 'plain'}-${Object.keys(define).length}.ts`)
  writeFileSync(f, `import ${JSON.stringify(spec)}\n`)
  let got = ''
  await Bun.build({
    entrypoints: [f],
    target: t.target,
    define,
    ...(t.conditions ? { conditions: [...t.conditions] } : {}),
    plugins: [{ name: 'o', setup: (b) => void b.onLoad({ filter: /node_modules/ }, (a) => ((got = a.path), { contents: '', loader: 'js' })) }],
  })
  return got
}

for (const t of TARGETS) {
  for (const [mode, define] of [['production define', PRODUCTION], ['no define', {}]] as const) {
    test(`F223: resolveNative equals the bundler for ${t.name}, ${mode}`, async () => {
      const root = tmp()
      pkg(root, 'multi', LAYOUT, FILES)
      clearResolveCache()
      const want = await bundlerPick(root, 'multi', t, define)
      expect(want).not.toBe('')
      expect(resolveNative('multi', root, t.target, define, { conditions: t.conditions ? [...t.conditions] : undefined })).toBe(want)
    })
  }
}

test('F223: the Cloudflare picks differ from the plain browser ones (the row proves something)', async () => {
  const root = tmp()
  pkg(root, 'multi', LAYOUT, FILES)
  const [plain, cf] = [await bundlerPick(root, 'multi', TARGETS[1], PRODUCTION), await bundlerPick(root, 'multi', TARGETS[2], PRODUCTION)]
  expect(cf).toContain('workerd.js')
  expect(plain).not.toBe(cf)
})

test('F223: sourceDirPlugin carries the Worker conditions to what a package source imports', async () => {
  const root = tmp()
  pkg(root, 'dep', LAYOUT, FILES)
  const host = join(root, 'node_modules/host')
  put(join(host, 'package.json'), JSON.stringify({ name: 'host' }))
  put(join(host, 'src.ts'), '')
  const staged = join(root, '.stage/x.ts')
  put(staged, 'import "dep"\n')
  clearResolveCache()
  const picked: string[] = []
  const onLoad = { name: 'o', setup: (b: Bun.PluginBuilder) => void b.onLoad({ filter: /node_modules\/dep/ }, (a) => (picked.push(a.path), { contents: '', loader: 'js' })) }
  const sourceOf = new Map([[staged, join(host, 'src.ts')]])
  const res = await Bun.build({ entrypoints: [staged], target: 'browser', conditions: [...CF_CONDITIONS], define: PRODUCTION, plugins: [sourceDirPlugin(sourceOf, root, [], 'browser', [...CF_CONDITIONS]), onLoad] })
  expect(res.success, res.logs.join('\n')).toBe(true)
  expect(picked).toEqual([join(root, 'node_modules/dep/workerd.js')])
})

// F224: answers survive the process, per lockfile.
test('F224: the answers are kept across builds, and dropped when the lockfile or the package changes', () => {
  const root = tmp()
  put(join(root, 'bun.lock'), '{}\n')
  pkg(root, 'cached', { main: 'main.js' }, { 'main.js': '' })
  const warnings: string[] = []
  const ask = () => resolveNative('cached', root, 'bun', PRODUCTION, { appRoot: root, timeoutMs: 1, warn: (m) => warnings.push(m) })
  // Seed with a real probe (generous timeout), then ask from a "new process" with a probe that cannot answer: a hit
  // never spawns, so it never warns.
  clearResolveCache()
  const first = resolveNative('cached', root, 'bun', PRODUCTION, { appRoot: root })
  clearResolveCache()
  expect(ask()).toBe(first)
  expect(warnings).toEqual([])
  // The package changed (its package.json mtime): re-asked.
  const pj = join(root, 'node_modules/cached/package.json')
  utimesSync(pj, new Date(), new Date(Date.now() + 5000))
  clearResolveCache()
  ask()
  expect(warnings).toHaveLength(1)
  // Re-seed, then the lockfile changes: the whole cache is stale.
  warnings.length = 0
  clearResolveCache()
  resolveNative('cached', root, 'bun', PRODUCTION, { appRoot: root })
  put(join(root, 'bun.lock'), '{ "changed": true }\n')
  clearResolveCache()
  ask()
  expect(warnings).toHaveLength(1)
  // No lockfile pins the install: nothing is kept.
  const bare = tmp()
  pkg(bare, 'cached', { main: 'main.js' }, { 'main.js': '' })
  clearResolveCache()
  resolveNative('cached', bare, 'bun', PRODUCTION, { appRoot: bare })
  clearResolveCache()
  warnings.length = 0
  resolveNative('cached', bare, 'bun', PRODUCTION, { appRoot: bare, timeoutMs: 1, warn: (m) => warnings.push(m) })
  expect(warnings).toHaveLength(1)
})

// F218 (TS side): `.` and `..` take the relative branch of sourceDirPlugin.
test('F218: a staged artifact importing ".." resolves in its component source directory', async () => {
  const root = tmp()
  put(join(root, 'ui/index.ts'), 'export const marker = "UI_INDEX"\n')
  put(join(root, 'ui/parts/comp.ts'), '')
  const staged = join(root, '.stage/comp.ts')
  put(staged, 'import { marker } from ".."\nconsole.log(marker)\n')
  const res = await Bun.build({ entrypoints: [staged], target: 'bun', plugins: [sourceDirPlugin(new Map([[staged, join(root, 'ui/parts/comp.ts')]]), root)] })
  expect(res.success, res.logs.join('\n')).toBe(true)
  expect(await res.outputs[0]!.text()).toContain('UI_INDEX')
})

// F241: the importer's own package.json (its `browser` / `imports` maps) is part of what an answer depends on.
test('F241: a cached answer is dropped when the importer package.json changed', () => {
  const root = tmp()
  put(join(root, 'bun.lock'), '{}\n')
  pkg(root, 'dep', { main: 'main.js' }, { 'main.js': '' })
  const host = join(root, 'node_modules/host')
  put(join(host, 'package.json'), JSON.stringify({ name: 'host' }))
  const warnings: string[] = []
  const ask = (timeoutMs: number) => resolveNative('dep', host, 'bun', PRODUCTION, { appRoot: root, timeoutMs, warn: (m) => warnings.push(m) })
  clearResolveCache()
  const first = ask(30_000)
  clearResolveCache()
  expect(ask(1)).toBe(first) // unchanged: a hit, no probe
  expect(warnings).toEqual([])
  utimesSync(join(host, 'package.json'), new Date(), new Date(Date.now() + 5000))
  clearResolveCache()
  ask(1) // the importer's package.json moved: the entry is dropped, the (timed-out) probe asks again
  expect(warnings).toHaveLength(1)
})

// F242: a browser-target build never takes the bun/node answer.
test('F242: a browser-target probe that cannot answer is an error naming the specifier, not the node pick', () => {
  const root = tmp()
  pkg(root, 'nodey', { exports: { node: './node.js', browser: './browser.js' } }, { 'node.js': '', 'browser.js': '' })
  clearResolveCache()
  const run = () => resolveNative('nodey', root, 'browser', PRODUCTION, { timeoutMs: 1, conditions: [...CF_CONDITIONS] })
  expect(run).toThrow('"nodey"')
  try {
    run()
  } catch (e) {
    expect((e as { rule?: string }).rule).toBe('resolve-fallback')
    expect(String(e)).not.toContain('node.js')
  }
  // The same failure for the bun target keeps today's answer (and names it).
  const warnings: string[] = []
  expect(resolveNative('nodey', root, 'bun', PRODUCTION, { timeoutMs: 1, warn: (m) => warnings.push(m) })).toContain('node_modules/nodey/')
  expect(warnings).toHaveLength(1)
})

// F245: the cache file is data; every answer read from it is checked.
function cacheFile(root: string): string {
  return join(root, '.brust', readdirSync(join(root, '.brust')).find((f) => f.startsWith('resolve-cache-'))!)
}
test('F245: a cached answer outside the app and node_modules, or a missing file, is dropped', () => {
  const root = tmp()
  put(join(root, 'bun.lock'), '{}\n')
  pkg(root, 'real', { main: 'main.js' }, { 'main.js': '' })
  const warnings: string[] = []
  const ask = () => resolveNative('real', root, 'bun', PRODUCTION, { appRoot: root, timeoutMs: 1, warn: (m) => warnings.push(m) })
  clearResolveCache()
  const real = resolveNative('real', root, 'bun', PRODUCTION, { appRoot: root })
  const file = cacheFile(root)
  const original = readFileSync(file, 'utf8')
  const plant = (path: string) => {
    const j = JSON.parse(original)
    for (const e of Object.values(j.entries) as { path: string; pkg: string }[]) {
      e.path = path
      e.pkg = ''
    }
    writeFileSync(file, JSON.stringify(j))
    clearResolveCache()
  }
  // A real file, but in neither the app nor a node_modules.
  plant('/etc/hosts')
  expect(ask()).toBe(real)
  expect(warnings).toHaveLength(1) // not served from the cache: the probe was asked (and timed out to the fallback)
  // Inside the app but gone.
  warnings.length = 0
  plant(join(root, 'gone.js'))
  ask()
  expect(warnings).toHaveLength(1)
  // The genuine file is served.
  warnings.length = 0
  writeFileSync(file, original)
  clearResolveCache()
  expect(ask()).toBe(real)
  expect(warnings).toEqual([])
})
