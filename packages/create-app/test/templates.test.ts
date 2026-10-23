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
import { TAILWIND_DEV_DEPS } from '../src/tailwind.ts'

const repo = join(import.meta.dir, '../../..')
const blank = join(import.meta.dir, '../templates/blank')
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const blankPkg = () => JSON.parse(readFileSync(join(blank, 'package.json.tmpl'), 'utf8').replace('__BRUST_DEP__', '"x"'))

test('blank has the E8 file set', () => {
  for (const f of ['package.json.tmpl', 'README.md.tmpl', '_gitignore', 'brust.toml', 'tsconfig.json', 'routes.tsx', 'actions.ts', 'components/Layout.tsx', 'components/Counter.tsx', 'pages/HomePage.tsx', 'app.css', 'public/favicon.svg']) {
    expect(existsSync(join(blank, f)), f).toBe(true)
  }
  // L28 R29.1: Tailwind CSS v4 is the blank template; the plain stylesheet is gone
  expect(existsSync(join(blank, 'public/app.css'))).toBe(false)
})
test('R25.2: the blank favicon is the docs site favicon, byte for byte (sha256 pinned; the docs-site branch is not in CI)', () => {
  const bytes = readFileSync(join(blank, 'public/favicon.svg'))
  expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe('529a1fa41828e326ab3cb7351d6bf1d3c2a681c9b2b3d37da5ae7f95fd73771a')
})
test('R25.1 / R29.2: the starter page loads no font, CDN or remote stylesheet; its one import is Tailwind', () => {
  const css = readFileSync(join(blank, 'app.css'), 'utf8')
  const layout = readFileSync(join(blank, 'components/Layout.tsx'), 'utf8')
  expect([...css.matchAll(/@import\s+([^;]+);/g)].map((m) => m[1])).toEqual(['"tailwindcss"'])
  expect(css).not.toMatch(/url\(|@font-face|https?:/)
  expect(layout).not.toMatch(/href="https?:/)
  expect(layout).toContain("import '../app.css'\n")
  expect(layout).not.toContain('/public/app.css')
})
test('R29.3: app.css holds the docs palette as @theme tokens with a dark override of the same tokens; no tailwind.config', () => {
  const css = readFileSync(join(blank, 'app.css'), 'utf8')
  const tokens = ['paper', 'sheet', 'ink', 'ink-2', 'rule', 'amber', 'amber-ink'].map((t) => `--color-${t}:`)
  const [theme, dark] = css.split('@media (prefers-color-scheme: dark)')
  for (const t of tokens) expect([t, theme!.includes(t), dark!.includes(t)]).toEqual([t, true, true])
  for (const f of ['tailwind.config.js', 'tailwind.config.ts']) expect(existsSync(join(blank, f)), f).toBe(false)
})
test('R29.2: the blank template pins the Tailwind dev dependencies to the versions brust builds with', () => {
  const pick = (deps: Record<string, string>) => Object.fromEntries(Object.keys(TAILWIND_DEV_DEPS).map((k) => [k, deps[k]]))
  expect(pick(blankPkg().devDependencies)).toEqual(TAILWIND_DEV_DEPS)
  const root = json(join(repo, 'package.json'))
  expect(pick(root.devDependencies)).toEqual(TAILWIND_DEV_DEPS)
  // L32 R33.2: one exact version for the compiler, its Node API and the scanner; the old plugin is gone
  expect(new Set(Object.values(TAILWIND_DEV_DEPS)).size).toBe(1)
  expect(blankPkg().devDependencies['bun-plugin-tailwind']).toBeUndefined()
})
test('blank pins equal the repo', () => {
  const core = json(join(repo, 'packages/brust/package.json'))
  const pokedex = json(join(repo, 'examples/pokedex/package.json'))
  const pkg = blankPkg()
  // elysia-rc D1/D2: brust's peer is a range (`^2.0.0-rc.0`), a new app pins exactly the pair brust is tested with (core's devDependencies), and satisfies the peer
  for (const k of ['elysia', '@elysia/eden']) {
    expect(pkg.dependencies[k]).toBe(core.devDependencies[k])
    expect(core.peerDependencies[k]).toBe(`^${pkg.dependencies[k]}`)
  }
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
