// F226: the `paths` the shadcn CLI uses are the ones `tsconfig-paths` 4.2.0 (the CLI's own resolver, pinned beside
// SHADCN_VERSION) makes of the `extends` chain, NOT TypeScript's: the paths base is the TOP file's directory, an inherited
// baseUrl is rebased by the extends specifier string, a package config is looked up only at <dir>/node_modules/<spec>,
// an unresolved parent counts as empty. The F193 pre-check asks that same code, and refuses a target outside the project.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { shadcnInit, TSCONFIG_PATHS_VERSION } from '../src/shadcn/init'

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

test('F226: a list of extends (later wins) and a chain two files long are read', async () => {
  const outside = outsideDir()
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

// Mellow F1 (a): the node_modules chain of the lane's earlier fixture. tsconfig-paths rebases the inner baseUrl
// "../../.." by dirname of the extends STRINGS ("@acme/config" then "."), not by where the files are, so the base is the
// PARENT of the project and the CLI would write outside it. TypeScript's reading (<project>/web) was a clean project.
test('F226 (a): a baseUrl inherited through a package config that lands outside the project is refused, with no link at all', async () => {
  const pkg = project({
    'tsconfig.json': '{ "extends": "@acme/config/tsconfig.json" }',
    'node_modules/@acme/config/tsconfig.json': '{ "extends": "./inner.json" }',
    'node_modules/@acme/config/inner.json': '{ "compilerOptions": { "baseUrl": "../../..", "paths": { "@/*": ["./web/*"] } } }',
  })
  mkdirSync(join(pkg, 'web'))
  const r = await init(pkg, ['button'])
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(r.text).toContain('outside the project')
})

// Mellow F1 (b): paths declared in ./config/base.json have no baseUrl, so they resolve from the TOP file's directory
// (<project>/src), not from config/. A link at src/components is the CLI's target.
test('F226 (b): inherited paths without a baseUrl resolve from the top tsconfig directory', async () => {
  const outside = outsideDir()
  const files = { 'tsconfig.json': '{ "extends": "./config/base.json" }', 'config/base.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }' }
  const d = project(files)
  mkdirSync(join(d, 'src'))
  symlinkSync(outside, join(d, 'src/components'))
  const r = await init(d, ['button'])
  expect(r.code).toBe(2)
  expect(r.text).toContain('src/components')
  // a link under config/src (where TypeScript would put it) is not a target
  const e = project(files)
  mkdirSync(join(e, 'config/src'), { recursive: true })
  symlinkSync(outside, join(e, 'config/src/components'))
  expect((await init(e, ['button'])).code).toBe(0)
})

// Mellow F1 (c): "@acme/tsconfig" is looked up by tsconfig-paths only at node_modules/@acme/tsconfig(.json) - there is no
// package.json "tsconfig" field and no <pkg>/tsconfig.json - so the parent counts as empty and the paths are the command's own.
test('F226 (c): a package config the CLI cannot find counts as empty, as the CLI sees it', async () => {
  const outside = outsideDir()
  const d = project({
    'tsconfig.json': '{ "extends": "@acme/tsconfig" }',
    'node_modules/@acme/tsconfig/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    'node_modules/@acme/tsconfig/package.json': '{ "name": "@acme/tsconfig" }',
  })
  mkdirSync(join(d, 'src'))
  symlinkSync(outside, join(d, 'src/components'))
  const r = await init(d, ['button'])
  expect(r.code).toBe(0) // src/ is not a target: the CLI sees no paths, so its target is the command's own @/* → ./*
  expect(r.text).toContain('not edited') // no compilerOptions to add the line to: the reader is told to
})

test('F226: a chain the CLI throws on is refused, and nothing is spawned or written', async () => {
  const outside = outsideDir()
  const cases: Record<string, Record<string, string>> = {
    'a parent that is not JSON': { 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ nope' },
    'a cycle': { 'tsconfig.json': '{ "extends": "./b.json" }', 'b.json': '{ "extends": "./tsconfig.json" }' },
    'a non-string extends': { 'tsconfig.json': '{ "extends": 3 }' },
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
  void outside
})

test('F226: a parent tsconfig-paths cannot find counts as empty (the CLI does the same); a ${configDir} stays literal', async () => {
  for (const ext of ['./missing.json', '@nope/config']) {
    const d = project({ 'tsconfig.json': `{ "extends": "${ext}" }` })
    expect((await init(d, ['button'])).code, ext).toBe(0)
    expect(readFileSync(join(d, 'tsconfig.json'), 'utf8'), ext).toBe(`{ "extends": "${ext}" }`)
  }
  // the CLI does not expand ${configDir}: it writes under a directory of that literal name, which is checked as any other
  const outside = outsideDir()
  const t = project({ 'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["${configDir}/*"] } } }' })
  mkdirSync(join(t, '${configDir}'))
  symlinkSync(outside, join(t, '${configDir}/components'))
  const r = await init(t, ['button'])
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
})

test('F226 control: an extends-only tsconfig whose chain has no paths still gets the @/* the command adds', async () => {
  const d = project({ 'tsconfig.json': '{ "extends": "./b.json", "compilerOptions": {} }', 'b.json': '{ "compilerOptions": { "strict": true } }' })
  const r = await init(d, ['button'])
  expect(r.code).toBe(0)
  expect(readFileSync(join(d, 'tsconfig.json'), 'utf8')).toContain('"@/*": ["./*"]')
})

test('F226: tsconfig-paths is a dependency at exactly the version the pinned CLI resolves with', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { dependencies: Record<string, string> }
  expect(TSCONFIG_PATHS_VERSION).toBe('4.2.0')
  expect(pkg.dependencies['tsconfig-paths']).toBe(TSCONFIG_PATHS_VERSION)
})

// F251 (Mellow R1): the CLI tries npm workspace packages before the tsconfig paths, a route the pre-check does not model.
// A package-shaped alias is refused even when a `paths` entry names it; the default `@/` aliases are not package-shaped.
test('F251: a package-shaped components.json alias (@scope/name) is refused, even when a paths entry names it', async () => {
  const d = project({ 'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"], "@acme/*": ["./acme/*"] } } }' })
  writeFileSync(join(d, 'components.json'), JSON.stringify({ aliases: { ui: '@acme/ui', components: '@/components', lib: '@/lib', hooks: '@/hooks', utils: '@/lib/utils' } }))
  const r = await init(d, ['button'])
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(r.text).toContain('looks like a package name')
  expect(r.text).toContain('"ui"')
  // a bare scoped alias with no path after the name is package-shaped too
  writeFileSync(join(d, 'components.json'), JSON.stringify({ aliases: { ui: '@acme/ui', components: '@acme/components', lib: '@/lib', hooks: '@/hooks', utils: '@/lib/utils' } }))
  expect((await init(d, ['button'])).code).toBe(2)
  // control: the default @/ aliases and a ~/ alias are unaffected
  const ok = project({ 'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"], "~/*": ["./src/*"] } } }' })
  writeFileSync(join(ok, 'components.json'), JSON.stringify({ aliases: { ui: '~/ui', components: '@/components', lib: '@/lib', hooks: '@/hooks', utils: '@/lib/utils' } }))
  expect((await init(ok, ['button'])).code).toBe(0)
  expect((await init(project({ 'tsconfig.json': '{ "compilerOptions": {} }' }), ['button'])).code).toBe(0)
})
