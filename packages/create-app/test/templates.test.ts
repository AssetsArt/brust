import { expect, test } from 'bun:test'
import { DEFAULT_TEMPLATE, listTemplates, selectTemplate } from '../src/templates.ts'

test('listTemplates returns blank + pokedex', () => expect(listTemplates().map((t) => t.name)).toEqual(['blank', 'pokedex']))
test('DEFAULT_TEMPLATE resolves to a registered template (blank)', () => {
  expect(DEFAULT_TEMPLATE).toBe('blank')
  expect(listTemplates().some((t) => t.name === DEFAULT_TEMPLATE)).toBe(true)
})
test('selectTemplate: explicit valid name', () => expect(selectTemplate({ explicit: 'pokedex', yes: false, isTTY: false }).name).toBe('pokedex'))
test('selectTemplate: explicit invalid name throws', () => {
  expect(() => selectTemplate({ explicit: 'x', yes: false, isTTY: false })).toThrow('unknown template "x" — choose one of: blank, pokedex')
})
test('selectTemplate: yes → default blank', () => expect(selectTemplate({ yes: true, isTTY: true }).name).toBe('blank'))
test('selectTemplate: non-TTY → default blank', () => expect(selectTemplate({ yes: false, isTTY: false }).name).toBe('blank'))
const tty = (answers: (string | null)[]) => { const out: string[] = []; const it = answers[Symbol.iterator](); return { out, opts: { yes: false, isTTY: true, read: () => { const n = it.next(); return n.done ? null : n.value }, print: (s: string) => { out.push(s) } } } }
test('selectTemplate: TTY + read "2" → pokedex', () => expect(selectTemplate(tty(['2']).opts).name).toBe('pokedex'))
test('selectTemplate: TTY + read "" → default blank', () => expect(selectTemplate(tty(['']).opts).name).toBe('blank'))
test('selectTemplate: TTY + read name "pokedex" → pokedex', () => expect(selectTemplate(tty(['pokedex']).opts).name).toBe('pokedex'))
test('selectTemplate: TTY + null reader → default blank (no infinite loop)', () => expect(selectTemplate(tty([]).opts).name).toBe('blank'))
test('selectTemplate: TTY + three invalid answers → default blank', () => {
  const t = tty(['9', 'nope', '0'])
  expect(selectTemplate(t.opts).name).toBe('blank')
  expect(t.out.join('')).toContain('Invalid selection "nope"')
})

// ---- blank template pins ----
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dir, '../../..')
const blank = join(import.meta.dir, '../templates/blank')
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const blankPkg = () => JSON.parse(readFileSync(join(blank, 'package.json.tmpl'), 'utf8').replace('__BRUST_DEP__', '"x"'))

test('blank has the E8 file set', () => {
  for (const f of ['package.json.tmpl', 'README.md.tmpl', '_gitignore', 'brust.toml', 'tsconfig.json', 'routes.tsx', 'actions.ts', 'components/Layout.tsx', 'components/Counter.tsx', 'pages/HomePage.tsx', 'public/app.css', 'public/favicon.svg']) {
    expect(existsSync(join(blank, f)), f).toBe(true)
  }
})
test('R25.2: the blank favicon is the docs site favicon, byte for byte (sha256 pinned; the docs-site branch is not in CI)', () => {
  const bytes = readFileSync(join(blank, 'public/favicon.svg'))
  expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe('529a1fa41828e326ab3cb7351d6bf1d3c2a681c9b2b3d37da5ae7f95fd73771a')
})
test('R25.1: the starter page loads no font, CDN or remote stylesheet', () => {
  const css = readFileSync(join(blank, 'public/app.css'), 'utf8')
  const layout = readFileSync(join(blank, 'components/Layout.tsx'), 'utf8')
  expect(css).not.toMatch(/@import|url\(|@font-face/)
  expect(layout).not.toMatch(/href="https?:/)
})
test('blank pins equal the repo', () => {
  const core = json(join(repo, 'packages/brust/package.json'))
  const pokedex = json(join(repo, 'examples/pokedex/package.json'))
  const pkg = blankPkg()
  expect(pkg.dependencies.elysia).toBe(core.peerDependencies.elysia)
  expect(pkg.dependencies['@elysia/eden']).toBe(core.peerDependencies['@elysia/eden'])
  for (const k of ['react', 'react-dom']) expect(pkg.dependencies[k]).toBe(pokedex.dependencies[k])
  for (const k of ['@types/bun', '@types/react', 'typescript']) expect(pkg.devDependencies[k]).toBe(pokedex.devDependencies[k])
})
test('blank scripts are dev/build/start/typecheck per R6 plus the Cloudflare pair (M4-CF R11)', () => {
  expect(blankPkg().scripts).toEqual({
    dev: 'brust dev routes.tsx',
    build: 'brust build routes.tsx',
    start: 'brust start',
    typecheck: 'bun check',
    'dev:cf': 'brust dev routes.tsx --target cloudflare',
    'deploy:cf': 'brust build routes.tsx --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc',
  })
})
test('blank Cloudflare files: wrangler devDependency, account-free scripts, a lean wrangler.jsonc', () => {
  const pkg = blankPkg()
  expect(pkg.devDependencies.wrangler).toMatch(/^\^\d+\.\d+\.0$/)
  for (const k of ['dev:cf', 'deploy:cf']) {
    expect(pkg.scripts[k]).not.toContain('--name')
    expect(pkg.scripts[k]).not.toContain('account')
  }
  const raw = readFileSync(join(blank, 'wrangler.jsonc.tmpl'), 'utf8')
  expect(raw).not.toContain('account_id')
  const w = Bun.JSONC.parse(raw.replaceAll('__PROJECT_NAME__', 'demo')) as Record<string, unknown>
  expect(w.name).toBe('demo')
  for (const k of ['main', 'assets', 'compatibility_date']) expect(w[k]).toBeUndefined()
  expect(readFileSync(join(blank, '_gitignore'), 'utf8')).toContain('.wrangler/')
})
test('blank brust.toml has [server] and an [actions] table', () => {
  const t = Bun.TOML.parse(readFileSync(join(blank, 'brust.toml'), 'utf8')) as Record<string, unknown>
  expect(t.server).toBeDefined()
  expect(t.actions).toEqual({})
})
test('blank actions.ts uses brust() and the Elysia 2 (path, hook, handler) order', () => {
  const src = readFileSync(join(blank, 'actions.ts'), 'utf8')
  expect(src).toContain('adapter: brust()')
  expect(src).toContain('export type App')
  expect(src).toMatch(/\.get\(\s*'\/hello',\s*\{ query:/)
})
