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
test('blank pins equal the repo', () => {
  const core = json(join(repo, 'packages/brust/package.json'))
  const pokedex = json(join(repo, 'examples/pokedex/package.json'))
  const pkg = blankPkg()
  expect(pkg.dependencies.elysia).toBe(core.peerDependencies.elysia)
  expect(pkg.dependencies['@elysia/eden']).toBe(core.peerDependencies['@elysia/eden'])
  for (const k of ['react', 'react-dom']) expect(pkg.dependencies[k]).toBe(pokedex.dependencies[k])
  for (const k of ['@types/bun', '@types/react', 'typescript']) expect(pkg.devDependencies[k]).toBe(pokedex.devDependencies[k])
})
test('blank scripts are dev/build/start/typecheck per R6', () => {
  expect(blankPkg().scripts).toEqual({ dev: 'brust build routes.tsx && brust start', build: 'brust build routes.tsx', start: 'brust start', typecheck: 'bun check' })
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
