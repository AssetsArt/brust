// F569: `[tiers]` of brust.toml. `[tiers.max]` fails a build that compiles a component to a heavier tier than its pattern
// allows, naming why; `[tiers] snapshot` records the tiers and fails a build that makes one heavier. An app report: the
// tier of a component changed with ordinary edits, the build only warned, and regressions shipped.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuildError, runBuild } from '../src/build'
import { loadBuildConfig } from '../src/build/config'

const FIXTURE = join(import.meta.dir, 'fixtures', 'tiers')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A fresh copy of the fixture app (inside the package, so `@brust/core` resolves) with this brust.toml. */
const app = (toml: string) => {
  const dir = mkdtempSync(join(import.meta.dir, '.tmp-tiers-'))
  dirs.push(dir)
  cpSync(FIXTURE, dir, { recursive: true })
  writeFileSync(join(dir, 'brust.toml'), toml)
  return dir
}

/** Builds `dir`: the log lines, and the BuildError when the build failed. */
const build = async (dir: string, o: { dev?: boolean; updateTiers?: boolean } = {}) => {
  const logs: string[] = []
  let error: BuildError | undefined
  try {
    await runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: join(dir, 'dist'), log: (l) => logs.push(l), ...o })
  } catch (e) {
    if (!(e instanceof BuildError)) throw e
    error = e
  }
  return { logs, tierLogs: logs.filter((l) => /^(warning tiers? |tiers: )/.test(l)), error }
}

const T = 120_000

test('a component within its max builds, and prints nothing', async () => {
  const r = await build(app('[tiers.max]\n"components/views/**" = "native"\n"components/widgets/**" = "react"\n"pages/**" = "native"\n'))
  expect(r.error).toBeUndefined()
  expect(r.tierLogs).toEqual([])
}, T)

test('react over static fails with file:line, the fallback rule, its message and the fix', async () => {
  const r = await build(app('[tiers.max]\n"components/widgets/**" = "static"\n'))
  expect(r.error?.rule).toBe('tier')
  const lines = (r.error?.message ?? '').split('\n')
  expect(lines[0]).toMatch(/^components\/widgets\/Wide\.tsx:2:\d+ Wide compiles to react; \[tiers\.max\] "components\/widgets\/\*\*" allows static$/)
  expect(lines[1]).toMatch(/^ {2}browser-global: render reads `window`/)
  expect(lines[2]).toBe('    fix: read browser globals in useEffect or an event handler')
}, T)

test('native over static fails naming the state and the handler, with their lines', async () => {
  const r = await build(app('[tiers.max]\n"components/views/**" = "static"\n'))
  expect(r.error?.rule).toBe('tier')
  expect(r.error?.message).toBe(
    [
      'components/views/Counter.tsx:4:1 Counter compiles to native; [tiers.max] "components/views/**" allows static',
      '  state `count` is set (line 4)',
      '  an event handler (line 6)',
    ].join('\n'),
  )
}, T)

test('every violation is listed in one error', async () => {
  const r = await build(app('[tiers.max]\n"components/**" = "static"\n'))
  const heads = (r.error?.message ?? '').split('\n').filter((l) => !l.startsWith(' '))
  expect(heads.map((h) => h.split(' ')[1])).toEqual(expect.arrayContaining(['Counter', 'Wide', 'Bell']))
}, T)

test('a pattern with #Export beats one without; #default addresses the default export', async () => {
  const r = await build(
    app('[tiers.max]\n"components/views/**" = "static"\n"components/views/Counter.tsx#default" = "native"\n"components/views/Badge.tsx#Badge" = "static"\n'),
  )
  expect(r.error).toBeUndefined()
  expect(r.tierLogs).toEqual([])
  // The #Export rule wins even over a longer path pattern.
  const named = await build(
    app('[tiers.max]\n"components/views/Counter.tsx" = "static"\n"components/**#default" = "native"\n"components/widgets/**#default" = "react"\n"components/shell/**#default" = "react"\n'),
  )
  expect(named.error).toBeUndefined()
}, T)

test('the pattern with more literal characters wins', async () => {
  const r = await build(app('[tiers.max]\n"components/**" = "static"\n"components/views/**" = "native"\n"components/widgets/**" = "react"\n"components/shell/**" = "react"\n'))
  expect(r.error).toBeUndefined()
}, T)

test('two patterns of the same weight with different tiers are a config error naming both', async () => {
  const r = await build(app('[tiers.max]\n"components/views/Count*.tsx" = "static"\n"components/views/*unter.tsx" = "native"\n'))
  expect(r.error?.rule).toBe('config')
  expect(r.error?.message).toContain('"components/views/Count*.tsx" (static) and "components/views/*unter.tsx" (native)')
  expect(r.error?.message).toContain('components/views/Counter.tsx#default')
}, T)

test('a pattern that matches no component warns, and the build succeeds', async () => {
  const r = await build(app('[tiers.max]\n"components/gone/**" = "static"\n"components/views/Card.tsx#Other" = "static"\n'))
  expect(r.error).toBeUndefined()
  expect(r.tierLogs).toEqual(['warning tiers "components/gone/**" matches no component', 'warning tiers "components/views/Card.tsx#Other" matches no component'])
}, T)

test('config errors: unknown key, unknown tier, non-string value, invalid pattern, bad snapshot path', async () => {
  const cases: [string, string][] = [
    ['[tiers]\nmode = "strict"\n', 'unknown key tiers.mode (allowed: snapshot, max)'],
    ['[tiers.max]\n"pages/**" = "fast"\n', 'tiers.max."pages/**" = "fast" is not a tier (allowed: static, native, react)'],
    ['[tiers.max]\n"pages/**" = 1\n', 'tiers.max."pages/**" must be a string'],
    ['[tiers.max]\n"/pages/**" = "static"\n', '[tiers.max] "/pages/**" is not a valid pattern: the path must be relative to the app root'],
    ['[tiers.max]\n"pages/Home.tsx#" = "static"\n', '[tiers.max] "pages/Home.tsx#" is not a valid pattern'],
    ['[tiers]\nsnapshot = 3\n', 'tiers.snapshot must be a /-separated path relative to the app root'],
    ['[tiers]\nmax = "static"\n', '[tiers.max] must be a table'],
  ]
  const dir = app('')
  for (const [toml, want] of cases) {
    writeFileSync(join(dir, 'brust.toml'), toml)
    const e = await loadBuildConfig(dir).then(
      () => undefined,
      (x: unknown) => x,
    )
    expect(e).toBeInstanceOf(BuildError)
    expect((e as BuildError).rule).toBe('config')
    expect((e as BuildError).message).toContain(want)
  }
  // D7: an actions-only build does not read [tiers].
  writeFileSync(join(dir, 'brust.toml'), '[tiers.max]\n"pages/**" = "fast"\n')
  expect((await loadBuildConfig(dir, { actionsOnly: true })).tiers).toBeNull()
})

test('snapshot: written when absent, unchanged build passes, heavier fails, lighter prints and keeps the file, --update-tiers rewrites', async () => {
  const dir = app('[tiers]\nsnapshot = "tiers.json"\n')
  const file = join(dir, 'tiers.json')
  const first = await build(dir)
  expect(first.error).toBeUndefined()
  const written = readFileSync(file, 'utf8')
  const snap = JSON.parse(written) as { version: number; components: Record<string, string> }
  expect(snap.version).toBe(1)
  expect(written.endsWith('}\n')).toBe(true)
  expect(Object.keys(snap.components)).toEqual(Object.keys(snap.components).sort())
  expect(snap.components['components/views/Card.tsx#default']).toBe('static')
  expect(snap.components['components/views/Badge.tsx#Badge']).toBe('static')
  expect(snap.components['components/views/Counter.tsx#default']).toBe('native')
  expect(snap.components['components/widgets/Wide.tsx#default']).toBe('react')
  // Source components only: the React copy of Bell is checked under Bell, not recorded.
  expect(snap.components['components/shell/Bell.tsx#default']).toBe('native')
  expect(Object.keys(snap.components).some((k) => k.includes('_r'))).toBe(false)
  expect(first.tierLogs).toEqual([`tiers: wrote tiers.json (${Object.keys(snap.components).length} components)`])

  const same = await build(dir)
  expect(same.error).toBeUndefined()
  expect(same.tierLogs).toEqual([])

  // Heavier than recorded: Counter recorded static.
  const heavier = { version: 1, components: { ...snap.components, 'components/views/Counter.tsx#default': 'static' } }
  writeFileSync(file, `${JSON.stringify(heavier, null, 2)}\n`)
  const failed = await build(dir)
  expect(failed.error?.rule).toBe('tier')
  expect(failed.error?.message).toBe(
    ['components/views/Counter.tsx:4:1 Counter compiles to native; tiers.json records static', '  state `count` is set (line 4)', '  an event handler (line 6)'].join('\n'),
  )

  // Lighter, new and removed: printed, the build succeeds, the file is kept as it is.
  const { 'components/views/Badge.tsx#Badge': _badge, ...rest } = snap.components
  const lighter = { version: 1, components: { ...rest, 'components/views/Card.tsx#default': 'native', 'components/views/Old.tsx#default': 'static' } }
  const lighterText = `${JSON.stringify(lighter, null, 2)}\n`
  writeFileSync(file, lighterText)
  const ok = await build(dir)
  expect(ok.error).toBeUndefined()
  expect(ok.tierLogs).toEqual([
    'tiers: components/views/Badge.tsx#Badge new -> static',
    'tiers: components/views/Card.tsx#default native -> static',
    'tiers: components/views/Old.tsx#default static -> removed',
  ])
  expect(readFileSync(file, 'utf8')).toBe(lighterText)

  // --update-tiers: no snapshot violation, the file is rewritten with this build's tiers and every difference printed.
  writeFileSync(file, `${JSON.stringify(heavier, null, 2)}\n`)
  const updated = await build(dir, { updateTiers: true })
  expect(updated.error).toBeUndefined()
  expect(updated.tierLogs).toEqual(['tiers: components/views/Counter.tsx#default static -> native', `tiers: wrote tiers.json (${Object.keys(snap.components).length} components)`])
  expect(readFileSync(file, 'utf8')).toBe(written)
}, T * 3)

test('--update-tiers still applies the max rules', async () => {
  const dir = app('[tiers]\nsnapshot = "tiers.json"\n\n[tiers.max]\n"components/widgets/**" = "static"\n')
  const r = await build(dir, { updateTiers: true })
  expect(r.error?.rule).toBe('tier')
  expect(existsSync(join(dir, 'tiers.json'))).toBe(false)
}, T)

test('a snapshot that is not valid JSON of that shape is a config error', async () => {
  const dir = app('[tiers]\nsnapshot = "tiers.json"\n')
  for (const [text, want] of [
    ['{ nope', 'is not valid JSON'],
    ['{"version":2,"components":{}}', 'has version 2'],
    ['{"version":1}', 'has no "components" object'],
    ['{"version":1,"components":{"a.tsx#default":"fast"}}', 'records "fast" for a.tsx#default'],
  ]) {
    writeFileSync(join(dir, 'tiers.json'), text as string)
    const r = await build(dir)
    expect(r.error?.rule).toBe('config')
    expect(r.error?.message).toContain(want as string)
  }
}, T * 2)

test('the React copy (_r) of a component under a static-only rule is a violation that names who places it', async () => {
  const r = await build(app('[tiers.max]\n"components/shell/Bell.tsx" = "native"\n'))
  expect(r.error?.rule).toBe('tier')
  const lines = (r.error?.message ?? '').split('\n')
  expect(lines[0]).toMatch(/^components\/shell\/Bell\.tsx:\d+:\d+ Bell \(the copy made where shell_\w+ places it\) compiles to react; \[tiers\.max\] "components\/shell\/Bell\.tsx" allows native$/)
  expect(lines[1]).toMatch(/^ {2}nested-fed-child: /)
}, T)

test('dev prints violations as warnings and goes on; the snapshot is not written', async () => {
  const dir = app('[tiers]\nsnapshot = "tiers.json"\n\n[tiers.max]\n"components/views/**" = "static"\n')
  const r = await build(dir, { dev: true })
  expect(r.error).toBeUndefined()
  const w = r.logs.filter((l) => l.startsWith('warning tier '))
  expect(w).toEqual([
    [
      'warning tier components/views/Counter.tsx:4:1 Counter compiles to native; [tiers.max] "components/views/**" allows static',
      '  state `count` is set (line 4)',
      '  an event handler (line 6)',
    ].join('\n'),
  ])
  expect(existsSync(join(dir, 'tiers.json'))).toBe(false)
  expect(existsSync(join(dir, 'dist', 'dev.json'))).toBe(true)
}, T)

// F581: a component under `[build] source_roots`, outside the app root, keys as `../…` and reports the line of its first cause.
/** A monorepo shape: `<tmp>/app` (inside the package, so `@brust/core` resolves) and `<tmp>/shared/Stateful.tsx`. */
const monorepo = (toml: string, shared: string) => {
  const root = mkdtempSync(join(import.meta.dir, '.tmp-tiers-sr-'))
  dirs.push(root)
  mkdirSync(join(root, 'app/pages'), { recursive: true })
  mkdirSync(join(root, 'shared'), { recursive: true })
  writeFileSync(join(root, 'shared/Stateful.tsx'), shared)
  writeFileSync(
    join(root, 'app/routes.tsx'),
    "import { defineRoutes } from '@brust/core/routes'\nimport Page from './pages/Page'\n\nexport const routes = defineRoutes([{ path: '/', Component: Page }])\n",
  )
  writeFileSync(join(root, 'app/pages/Page.tsx'), "import { Stateful } from '../../shared/Stateful'\n\nexport default function Page() {\n  return <main><Stateful /></main>\n}\n")
  writeFileSync(join(root, 'app/brust.toml'), toml)
  return join(root, 'app')
}

const STATIC_SHARED = "export function Stateful() {\n  return <button type=\"button\">x</button>\n}\n"
const NATIVE_SHARED = "import { useState } from 'react'\n\nexport function Stateful() {\n  const [n, setN] = useState(0)\n  return (\n    <button type=\"button\" onClick={() => setN(n + 1)}>\n      {n}\n    </button>\n  )\n}\n"

test('a source_roots component outside the app reports its first cause line, for the snapshot and for [tiers.max]', async () => {
  const key = '../shared/Stateful.tsx#Stateful'
  const dir = monorepo('[build]\nsource_roots = ["../shared"]\n\n[tiers]\nsnapshot = "tiers.json"\n', STATIC_SHARED)
  const first = await build(dir)
  expect(first.error).toBeUndefined()
  const snap = JSON.parse(readFileSync(join(dir, 'tiers.json'), 'utf8'))
  expect(snap.components[key]).toBe('static')
  // Made native: the snapshot records static.
  writeFileSync(join(dir, '../shared/Stateful.tsx'), NATIVE_SHARED)
  const failed = await build(dir)
  expect(failed.error?.rule).toBe('tier')
  expect(failed.error?.message.split('\n').slice(0, 3)).toEqual(['../shared/Stateful.tsx:4:1 Stateful compiles to native; tiers.json records static', '  state `n` is set (line 4)', '  an event handler (line 6)'])
  // The same component against a [tiers.max] pattern keyed the same way.
  const max = monorepo('[build]\nsource_roots = ["../shared"]\n\n[tiers.max]\n"../shared/**" = "static"\n', NATIVE_SHARED)
  const over = await build(max)
  expect(over.error?.rule).toBe('tier')
  expect(over.error?.message.split('\n')[0]).toBe('../shared/Stateful.tsx:4:1 Stateful compiles to native; [tiers.max] "../shared/**" allows static')
}, T * 3)

test('--update-tiers with no snapshot configured says it has no effect, with or without [tiers]', async () => {
  const line = 'tiers: --update-tiers has no effect: no [tiers] snapshot is configured'
  const bare = await build(app(''), { updateTiers: true })
  expect(bare.error).toBeUndefined()
  expect(bare.tierLogs).toEqual([line])
  const maxOnly = await build(app('[tiers.max]\n"components/views/**" = "native"\n'), { updateTiers: true })
  expect(maxOnly.error).toBeUndefined()
  expect(maxOnly.tierLogs).toEqual([line])
  // Without the flag nothing is printed; with a snapshot the flag works as before (covered above).
  const plain = await build(app(''))
  expect(plain.tierLogs).toEqual([])
}, T * 3)

test('the tier check runs after the compile: a build error stops the build before [tiers.max] is read', async () => {
  const dir = app('[tiers.max]\n"components/views/**" = "static"\n')
  // Counter breaks the max rule (native) and now also fails to compile: a list of elements without keys.
  writeFileSync(
    join(dir, 'components/views/Counter.tsx'),
    "import { useState } from 'react'\n\nexport default function Counter() {\n  const [count, setCount] = useState(0)\n  return (\n    <button type=\"button\" onClick={() => setCount(count + 1)}>\n      {[1, 2].map((n) => <i>{n}</i>)}\n    </button>\n  )\n}\n",
  )
  const r = await build(dir)
  expect(r.error).toBeDefined()
  expect(r.error?.rule).toBe('list-key')
  expect(r.error?.message).not.toContain('compiles to native')
}, T)

test('a native component whose only cause is a ref reports the line that binds it, in the app and under source_roots', async () => {
  // Counter's only cause is `ref={el}`: no state, no handler.
  const dir = app('[tiers.max]\n"components/views/**" = "static"\n')
  writeFileSync(
    join(dir, 'components/views/Counter.tsx'),
    "import { useRef } from 'react'\n\nexport default function Counter() {\n  const el = useRef<HTMLButtonElement>(null)\n  return <button type=\"button\" ref={el}>x</button>\n}\n",
  )
  const inApp = await build(dir)
  expect(inApp.error?.rule).toBe('tier')
  expect(inApp.error?.message.split('\n')).toEqual(['components/views/Counter.tsx:5:1 Counter compiles to native; [tiers.max] "components/views/**" allows static', '  a ref `el` (line 5)'])

  const REF_SHARED = "import { useRef } from 'react'\n\nexport function Stateful() {\n  const r = useRef<HTMLButtonElement>(null)\n  return <button type=\"button\" ref={r}>x</button>\n}\n"
  const outside = await build(monorepo('[build]\nsource_roots = ["../shared"]\n\n[tiers.max]\n"../shared/**" = "static"\n', REF_SHARED))
  expect(outside.error?.rule).toBe('tier')
  expect(outside.error?.message.split('\n')).toEqual(['../shared/Stateful.tsx:5:1 Stateful compiles to native; [tiers.max] "../shared/**" allows static', '  a ref `r` (line 5)'])
}, T * 2)
