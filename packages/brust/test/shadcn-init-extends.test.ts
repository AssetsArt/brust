// F226: the `paths` the shadcn CLI uses are the ones of the whole tsconfig `extends` chain. The F193 pre-check reads
// that chain (relative files, a package config, a list, `baseUrl`), and refuses when it cannot be read: never `@/*` by guess.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { shadcnInit } from '../src/shadcn/init'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-ext-')))
  dirs.push(d)
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', dependencies: { '@brust/core': '^2.0.0-alpha.10' } }))
  writeFileSync(join(d, 'app.css'), '@import "tailwindcss";\n')
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true })
    writeFileSync(join(d, f), text)
  }
  return d
}

async function init(root: string, components: string[] = []) {
  const calls: string[][] = []
  const lines: string[] = []
  const code = await shadcnInit({ root, components, run: async (a) => (calls.push(a), 0), out: (s) => lines.push(s) })
  return { calls, lines, code, text: lines.join('\n') }
}

const outsideDir = (): string => {
  const o = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-ext-out-')))
  dirs.push(o)
  return o
}

test('F226: an inherited "@/*" → ./src/* is what the pre-check walks (a link under src/components is refused)', async () => {
  const d = project({ 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }', 'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }' })
  const outside = outsideDir()
  mkdirSync(join(d, 'src'))
  symlinkSync(outside, join(d, 'src/components'))
  const r = await init(d, ['button'])
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(r.text).toContain('src/components')
  // the same project without the link runs the CLI, and the extending tsconfig is not edited (an own "paths" would replace the inherited ones)
  const clean = project({ 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }', 'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }' })
  const ok = await init(clean, ['button'])
  expect(ok.code).toBe(0)
  expect(readFileSync(join(clean, 'tsconfig.json'), 'utf8')).toBe('{ "extends": "./tsconfig.base.json" }')
})

test('F226: an inherited @/* that is exactly ./* is "present"; another mapping is warned about, like an own one', async () => {
  const same = project({ 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }' })
  expect((await init(same)).text).toContain('"@/*" is already there')
  const other = project({ 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ "compilerOptions": { "paths": { "@/*": ["./app/*"] } } }' })
  const r = await init(other)
  expect(r.code).toBe(0)
  expect(r.text).toContain('warning: "@/*" already points at')
})

test('F226: inherited paths with another mapping and no "@/*" are refused, never assumed', async () => {
  const d = project({ 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }' })
  const r = await init(d, ['button'])
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(r.text).toContain('does not resolve')
})

test('F226: an own "paths" replaces the inherited ones whole; baseUrl is inherited and moves the targets', async () => {
  const own = project({ 'tsconfig.json': '{ "extends": "./b.json", "compilerOptions": { "paths": { "@/*": ["./*"] } } }', 'b.json': '{ "compilerOptions": { "paths": { "@/*": ["./nope/*"] } } }' })
  const outside = outsideDir()
  mkdirSync(join(own, 'nope'))
  symlinkSync(outside, join(own, 'nope/components'))
  expect((await init(own, ['button'])).code).toBe(0) // the own mapping wins: nope/ is not a target
  const based = project({ 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ "compilerOptions": { "baseUrl": "./lib-root", "paths": { "@/*": ["./*"] } } }' })
  mkdirSync(join(based, 'lib-root'))
  symlinkSync(outside, join(based, 'lib-root/components'))
  const r = await init(based, ['button'])
  expect(r.code).toBe(2)
  expect(r.text).toContain('lib-root/components')
})

test('F226: a package config in node_modules, a list of extends (later wins) and a chain two files long are read', async () => {
  const outside = outsideDir()
  const pkg = project({
    'tsconfig.json': '{ "extends": "@acme/config/tsconfig.json" }',
    'node_modules/@acme/config/tsconfig.json': '{ "extends": "./inner.json" }',
    'node_modules/@acme/config/inner.json': '{ "compilerOptions": { "baseUrl": "../../..", "paths": { "@/*": ["./web/*"] } } }',
  })
  mkdirSync(join(pkg, 'web'))
  symlinkSync(outside, join(pkg, 'web/components'))
  expect((await init(pkg, ['button'])).code).toBe(2)
  const list = project({
    'tsconfig.json': '{ "extends": ["./one.json", "./two.json"] }',
    'one.json': '{ "compilerOptions": { "paths": { "@/*": ["./one/*"] } } }',
    'two.json': '{ "compilerOptions": { "paths": { "@/*": ["./two/*"] } } }',
  })
  mkdirSync(join(list, 'two'))
  symlinkSync(outside, join(list, 'two/components'))
  expect((await init(list, ['button'])).code).toBe(2) // two.json is later: its mapping is the one in force
  const one = project({ 'tsconfig.json': '{ "extends": ["./one.json", "./two.json"] }', 'one.json': '{ "compilerOptions": { "paths": { "@/*": ["./one/*"] } } }', 'two.json': '{}' })
  mkdirSync(join(one, 'one'))
  symlinkSync(outside, join(one, 'one/components'))
  expect((await init(one, ['button'])).code).toBe(2) // two.json has no paths: one.json's stay
})

test('F226: a chain that cannot be read is refused with the file named, and nothing is spawned or written', async () => {
  const outside = outsideDir()
  const cases: Record<string, Record<string, string>> = {
    'a missing file': { 'tsconfig.json': '{ "extends": "./missing.json" }' },
    'an unresolvable package': { 'tsconfig.json': '{ "extends": "@nope/config" }' },
    'a parent that is not JSON': { 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ nope' },
    'a cycle': { 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ "extends": "./tsconfig.json" }' },
    'a non-string extends': { 'tsconfig.json': '{ "extends": 3 }' },
    'a configDir template': { 'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["${configDir}/*"] } } }' },
  }
  for (const [name, files] of Object.entries(cases)) {
    const d = project(files)
    const before = readFileSync(join(d, 'tsconfig.json'), 'utf8')
    const r = await init(d, ['button'])
    expect(r.code, name).toBe(2)
    expect(r.calls, name).toEqual([])
    expect(readFileSync(join(d, 'tsconfig.json'), 'utf8'), name).toBe(before)
    expect(() => readFileSync(join(d, 'components.json')), name).toThrow()
  }
  expect((await init(project({ 'tsconfig.json': '{ "extends": "./missing.json" }' }))).text).toContain('missing.json')
  void outside
})

test('F226 control: an extends-only tsconfig whose chain has no paths still gets the @/* the command adds', async () => {
  const d = project({ 'tsconfig.json': '{ "extends": "./b.json", "compilerOptions": {} }', 'b.json': '{ "compilerOptions": { "strict": true } }' })
  const r = await init(d, ['button'])
  expect(r.code).toBe(0)
  expect(readFileSync(join(d, 'tsconfig.json'), 'utf8')).toContain('"@/*": ["./*"]')
})
