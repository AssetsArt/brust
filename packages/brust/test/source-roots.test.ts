// F256: `brust.toml` `[build] source_roots` lets a monorepo app import shared source above its root (F243 confined the
// compiler to the app). The roots are normalised, must exist, and confine imports the way the app root does.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseSourceRoots } from '../src/build/config'
import { BuildError } from '../src/build/errors'

const MONO = join(import.meta.dir, 'fixtures/monorepo')
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

/** A copy of the fixture's app next to the shared source: `<name>/` inside the fixture, so `../shared` is the real one. */
function variant(name: string, files: Record<string, string | null>): string {
  const dir = join(MONO, name)
  made.push(dir)
  rmSync(dir, { recursive: true, force: true })
  cpSync(join(MONO, 'app'), dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, f), { force: true })
    else writeFileSync(join(dir, f), text)
  }
  return dir
}

function build(app: string) {
  const out = join(app, 'dist-sr')
  made.push(out)
  const r = Bun.spawnSync([process.execPath, CLI, 'build', 'routes.tsx', '--target', 'static', '--out-dir', 'dist-sr'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, html: join(out, 'static/index.html') }
}

/** What React renders for the same tree. */
async function reactHtml(): Promise<string> {
  const { default: Page } = await import(join(MONO, 'app/Page.tsx'))
  return renderToStaticMarkup(createElement(Page))
}

const strip = (s: string) => s.replace(/\s+/g, ' ')

test('F256: with source_roots a sibling shared directory compiles and serves what React renders', async () => {
  const b = build(variant('app-ok', {}))
  expect(b.code, b.out).toBe(0)
  const html = readFileSync(b.html, 'utf8')
  const want = await reactHtml()
  // The framework wraps the page; the page's own markup is the same string.
  expect(strip(html)).toContain(strip(want))
  expect(html).toContain('<button class="btn">Press</button>')
  expect(html).toContain('<button class="btn">Close</button>') // Card imports ../Button: up inside the root
})

test('F256: without the setting the import is refused by name', () => {
  const b = build(variant('app-bare', { 'brust.toml': null }))
  expect(b.code).not.toBe(0)
  expect(b.out).toContain('leaves the app root')
  expect(existsSync(b.html)).toBe(false)
})

test('F256: a root written with ".." chains is normalised', () => {
  const b = build(variant('app-norm', { 'brust.toml': '[build]\nsource_roots = ["../app-norm/../shared/."]\n' }))
  expect(b.code, b.out).toBe(0)
})

test('F256: a path that escapes a source root is refused by name', () => {
  const b = build(
    variant('app-leak', {
      'Page.tsx': "import Leak from '../shared/leak'\nexport default function Page() { return <main><Leak /></main> }\n",
    }),
  )
  expect(b.code).not.toBe(0)
  expect(b.out).toContain('leaves the app root')
  expect(existsSync(b.html)).toBe(false)
})

test('F256: a root that does not cover the import is refused (siblings are not shared)', () => {
  const b = build(variant('app-other', { 'brust.toml': '[build]\nsource_roots = ["../secret"]\n' }))
  expect(b.code).not.toBe(0)
  expect(b.out).toContain('leaves the app root')
})

test('F256: the setting is validated: array of existing relative directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'brust-sr-'))
  made.push(root)
  mkdirSync(join(root, 'app/src'), { recursive: true })
  mkdirSync(join(root, 'shared'))
  writeFileSync(join(root, 'file.txt'), '')
  const app = join(root, 'app')
  const rule = (raw: unknown) => {
    try {
      parseSourceRoots('brust.toml', app, raw)
    } catch (e) {
      return e instanceof BuildError ? `${e.rule}: ${e.message}` : String(e)
    }
    return 'ok'
  }
  expect(parseSourceRoots('brust.toml', app, undefined)).toEqual([])
  expect(parseSourceRoots('brust.toml', app, ['../shared', '../app/../shared/', 'src/../src'])).toEqual(['../shared'])
  expect(rule('../shared')).toContain('must be an array')
  expect(rule([''])).toContain('non-empty')
  expect(rule([3])).toContain('non-empty')
  expect(rule(['../missing'])).toContain('not an existing directory')
  expect(rule(['../file.txt'])).toContain('not an existing directory')
  expect(rule([join(root, 'shared')])).toContain('relative to the app root')
  expect(rule(['/'])).toContain('relative to the app root')
  // F272: the app root or an ancestor of it would switch the confinement off for that whole level.
  for (const p of ['.', 'src/..', '..', '../..', '../app/..', '../shared/../..']) expect(rule([p])).toContain('contains it')
  expect(rule(['../shared', '..'])).toContain('contains it')
})
