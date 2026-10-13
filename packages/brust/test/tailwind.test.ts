// L21 tailwind (R21.1-R21.2) + L32 (R33.2-R33.6): Tailwind CSS v4 through brust's own plugin over the app's
// tailwindcss / @tailwindcss/node / @tailwindcss/oxide, on test/fixtures/tw-app with the real CLI (the repo pins the
// three as dev dependencies).
// The Chromium half (computed styles, the dev CSS swap) is tests/server/tailwind.chromium.test.ts.
// Run alone: `bun test --timeout 300000 test/tailwind.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCss, tailwindUse } from '../src/build/css'
import { loadTailwind, tailwindVersions, versionBelow } from '../src/build/tailwind'

const fixture = join(import.meta.dir, 'fixtures/tw-app')
const bin = join(import.meta.dir, '../bin/brust')
const temps: string[] = []
const copies: string[] = []
let css: string[] = []
let stdout = ''

function build(cwd: string) {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: b.exitCode, stdout: b.stdout.toString(), stderr: b.stderr.toString() }
}
function tmp(files: Record<string, string>): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-tw-')))
  temps.push(d)
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(join(d, k, '..'), { recursive: true })
    writeFileSync(join(d, k), v)
  }
  return d
}
function variant(name: string, edit: (dir: string) => void): string {
  const dir = join(import.meta.dir, `fixtures/.tw-${name}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes('/dist') })
  copies.push(dir)
  edit(dir)
  return dir
}

beforeAll(() => {
  rmSync(join(fixture, 'dist'), { recursive: true, force: true })
  const b = build(fixture)
  if (b.code !== 0) throw new Error(`brust build failed:\n${b.stderr}`)
  stdout = b.stdout
  const m = JSON.parse(readFileSync(join(fixture, 'dist/manifest.json'), 'utf8')) as { routes: { css?: string[] }[] }
  css = m.routes[0]!.css!.map((f) => readFileSync(join(fixture, 'dist', f), 'utf8'))
}, 300_000)

afterAll(() => {
  for (const d of [join(fixture, 'dist'), ...copies, ...temps]) rmSync(d, { recursive: true, force: true })
})

test('R21.1: @import "tailwindcss" compiles; utilities used in .tsx are scanned; @theme tokens apply; minified', () => {
  const app = css[0]!
  expect(app).toContain('.text-brand{color:var(--color-brand)}')
  expect(app).toContain('--color-brand:#0c2238')
  expect(app).toContain('md\\:text-4xl')
  expect(app).toContain('hover\\:underline')
  expect(app).not.toContain('\n  ')
  expect(stdout).not.toContain('warning tailwind')
})

test('R21.2: a module that @references app.css can @apply utilities and theme tokens', () => {
  expect(css[1]).toMatch(/^\.card_[A-Za-z0-9]+\{padding:calc\(var\(--spacing,\.25rem\)\*4\);color:var\(--color-brand,#0c2238\)\}/)
})

test('detection: @import "tailwindcss", @apply, @reference, @theme, @plugin, also through a relative @import; plain CSS is not Tailwind', () => {
  const d = tmp({
    'a.css': '@import "./b.css";\nbody{margin:0}',
    'b.css': "@import 'tailwindcss';",
    'c.css': '.x{@apply p-2}',
    'd.css': '@reference "./b.css";',
    'e.css': '@theme { --color-x: red }',
    'f.css': '@plugin "@tailwindcss/typography";',
    'plain.css': '.apply{color:red} /* tailwindcss */',
  })
  const r = tailwindUse(['a.css', 'c.css', 'd.css', 'e.css', 'f.css', 'plain.css'].map((f) => join(d, f)))
  expect(r.using.map((f) => f.slice(d.length + 1))).toEqual(['b.css', 'c.css', 'd.css', 'e.css', 'f.css'])
  expect(r.imports.map((f) => f.slice(d.length + 1))).toEqual(['b.css'])
  expect(tailwindUse([join(d, 'plain.css')])).toEqual({ using: [], imports: [] })
})

test('missing packages: tailwind-missing with the exact bun add -d command; plain CSS never needs them', async () => {
  const d = tmp({ 'app.css': '@import "tailwindcss";', 'plain.css': 'body{margin:0}' })
  const err = await loadTailwind(d, join(d, 'app.css'), () => true).then(
    () => '',
    (e: unknown) => `${(e as { rule?: string }).rule}: ${(e as Error).message}`,
  )
  expect(err).toBe(
    'tailwind-missing: app.css uses Tailwind CSS, but tailwindcss, @tailwindcss/node, @tailwindcss/oxide are not installed in the app: run `bun add -d tailwindcss@4 @tailwindcss/node@4 @tailwindcss/oxide@4`',
  )
  const dist = tmp({ 'client/.keep': '' })
  const viaBuild = await buildCss(dist, [join(d, 'app.css')], true, { appRoot: d }).then(() => '', (e) => (e as { rule?: string }).rule)
  expect(viaBuild).toBe('tailwind-missing')
  const plain = await buildCss(tmp({ 'client/.keep': '' }), [join(d, 'plain.css')], true, { appRoot: d })
  expect(plain.file.size).toBe(1)
})

test('a second @import "tailwindcss" warns (the whole of Tailwind would ship twice)', () => {
  const two = variant('two', (d) => {
    writeFileSync(join(d, 'extra.css'), '@import "tailwindcss";\n')
    writeFileSync(join(d, 'Home.tsx'), `import './extra.css'\n${readFileSync(join(d, 'Home.tsx'), 'utf8')}`)
  })
  const b = build(two)
  expect(b.code).toBe(0)
  expect(b.stdout).toContain('[brust] warning tailwind @import "tailwindcss" is in 2 files (app.css, extra.css)')
}, 120_000)

test('R33.6(a): the CSS banner is the tailwindcss the app installed, and one version runs the whole build', () => {
  const installed = (JSON.parse(readFileSync(Bun.resolveSync('tailwindcss/package.json', fixture), 'utf8')) as { version: string }).version
  expect(css[0]!).toContain(`tailwindcss v${installed} `)
  const v = tailwindVersions(fixture)
  expect([v.app, v.compiler, v.node, v.oxide]).toEqual([installed, installed, installed, installed])
  expect(stdout).not.toContain('tailwind-version')
})

test('R33.6(b): a utility added after 4.1 (pbs-*, Tailwind 4.2.0 changelog "Added", #19601) is compiled', () => {
  expect(css[0]!).toMatch(/\.pbs-4\{padding-block-start:calc\(var\(--spacing\)\*4\)\}/)
})

test('R33.3: a compiler that is not the app tailwindcss is a loud warning with the command that aligns them', async () => {
  const pkg = (name: string, version: string) => JSON.stringify({ name, version, main: 'index.js' })
  const d = tmp({
    'app.css': '@import "tailwindcss";',
    'node_modules/tailwindcss/package.json': pkg('tailwindcss', '4.3.2'),
    'node_modules/@tailwindcss/node/package.json': pkg('@tailwindcss/node', '4.3.3'),
    'node_modules/@tailwindcss/node/node_modules/tailwindcss/package.json': pkg('tailwindcss', '4.3.3'),
    'node_modules/@tailwindcss/oxide/package.json': pkg('@tailwindcss/oxide', '4.3.3'),
  })
  expect(tailwindVersions(d)).toEqual({ app: '4.3.2', compiler: '4.3.3', node: '4.3.3', oxide: '4.3.3' })
  const logs: string[] = []
  // the stand-in packages have no code, so loading them fails after the version check has spoken
  await loadTailwind(d, join(d, 'app.css'), () => true, (s) => logs.push(s)).catch(() => {})
  expect(logs).toEqual([
    '[brust] warning tailwind-version the app has tailwindcss 4.3.2, but the compiler is tailwindcss 4.3.3 (@tailwindcss/node 4.3.3, @tailwindcss/oxide 4.3.3): install one version of all three: bun add -d --exact tailwindcss@4.3.2 @tailwindcss/node@4.3.2 @tailwindcss/oxide@4.3.2',
  ])
  expect(dirname(Bun.resolveSync('tailwindcss/package.json', d))).toBe(join(d, 'node_modules/tailwindcss'))
})

test('review F1: Tailwind older than 4.1.0 fails the build with tailwind-version and the command to the tested set, before anything is built', async () => {
  const pkg = (name: string, version: string) => JSON.stringify({ name, version, main: 'index.js' })
  const d = tmp({
    'app.css': '@import "tailwindcss";',
    'node_modules/tailwindcss/package.json': pkg('tailwindcss', '4.0.17'),
    'node_modules/@tailwindcss/node/package.json': pkg('@tailwindcss/node', '4.0.17'),
    'node_modules/@tailwindcss/oxide/package.json': pkg('@tailwindcss/oxide', '4.0.17'),
  })
  const err = await loadTailwind(d, join(d, 'app.css'), () => true).then(
    () => '',
    (e: unknown) => `${(e as { rule?: string }).rule}: ${(e as Error).message}`,
  )
  expect(err).toBe(
    'tailwind-version: app.css uses Tailwind CSS, but tailwindcss 4.0.17, the compiler tailwindcss 4.0.17, @tailwindcss/node 4.0.17, @tailwindcss/oxide 4.0.17 are older than 4.1.0, the oldest brust builds with: run `bun add -d --exact tailwindcss@4.3.3 @tailwindcss/node@4.3.3 @tailwindcss/oxide@4.3.3`',
  )
  // through the CSS build: the same rule, and no stylesheet is written
  const dist = tmp({ 'client/.keep': '' })
  const viaBuild = await buildCss(dist, [join(d, 'app.css')], true, { appRoot: d }).then(
    () => '',
    (e: unknown) => (e as { rule?: string }).rule,
  )
  expect(viaBuild).toBe('tailwind-version')
  expect(readdirSync(join(dist, 'client'))).toEqual(['.keep'])
  expect([versionBelow('4.0.17', '4.1.0'), versionBelow('4.1.0', '4.1.0'), versionBelow('4.3.3', '4.1.0'), versionBelow('4.1.0-beta.1', '4.1.0')]).toEqual([true, false, false, false])
})
