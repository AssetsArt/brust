// L21 tailwind (R21.1-R21.2): Tailwind CSS v4 through the app's own `bun-plugin-tailwind`, on
// test/fixtures/tw-app with the real CLI (the repo pins tailwindcss + bun-plugin-tailwind as dev dependencies).
// The Chromium half (computed styles, the dev CSS swap) is tests/server/tailwind.chromium.test.ts.
// Run alone: `bun test --timeout 300000 test/tailwind.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCss, loadTailwind, tailwindUse } from '../src/build/css'

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
  const err = await loadTailwind(d, join(d, 'app.css')).then(() => '', (e) => `${(e as { rule?: string }).rule}: ${(e as Error).message}`)
  expect(err).toBe('tailwind-missing: app.css uses Tailwind CSS, but tailwindcss and bun-plugin-tailwind are not installed in the app: run `bun add -d tailwindcss@4 bun-plugin-tailwind`')
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
