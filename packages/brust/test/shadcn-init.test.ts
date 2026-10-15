// F175 (R41.1-R41.10): `brust shadcn init`. The process runner is injected, so no network: every branch of the plan is
// covered with real files in a temp project and a recording runner.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAliasPath, componentsJson, SHADCN_DEP_PINS, SHADCN_DEPS, SHADCN_VERSION, shadcnInit } from '../src/shadcn/init'
import { readObject } from '../src/shadcn/jsonc'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const TSCONFIG = `{
  "compilerOptions": {
    // Environment setup
    "lib": ["ESNext", "DOM"],
    "moduleResolution": "bundler", /* bundler mode */
    "strict": true,
  },
  "exclude": ["dist"],
}
`
const THEME = '@import "tailwindcss";\n@import "tw-animate-css";\n@import "shadcn/tailwind.css";\n'

function project(over: { pkg?: object | null; tsconfig?: string | null; css?: string | null } = {}): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-init-')))
  dirs.push(d)
  if (over.pkg !== null) writeFileSync(join(d, 'package.json'), JSON.stringify(over.pkg ?? { name: 'a', dependencies: { '@brust/core': '^2.0.0-alpha.10' } }))
  if (over.tsconfig !== null) writeFileSync(join(d, 'tsconfig.json'), over.tsconfig ?? TSCONFIG)
  if (over.css !== null) writeFileSync(join(d, 'app.css'), over.css ?? '@import "tailwindcss";\n')
  return d
}

interface Run {
  calls: string[][]
  lines: string[]
  code: number
}

/** Runs the command with a recording runner; `fail` makes the call whose argv contains it exit 7. */
async function init(root: string, args: { components?: string[]; fail?: string } & Record<string, unknown> = {}): Promise<Run> {
  const calls: string[][] = []
  const lines: string[] = []
  const { components = [], fail, ...rest } = args
  const code = await shadcnInit({
    root,
    components,
    run: async (argv) => {
      calls.push(argv)
      return fail !== undefined && argv.includes(fail) ? 7 : 0
    },
    out: (s) => lines.push(s),
    ...rest,
  } as Parameters<typeof shadcnInit>[0])
  return { calls, lines, code }
}

test('a directory that is not a brust project exits 2 and writes nothing (R41.1)', async () => {
  const none = project({ pkg: null })
  expect((await init(none)).code).toBe(2)
  expect(existsSync(join(none, 'components.json'))).toBe(false)
  const other = project({ pkg: { name: 'x', dependencies: { react: '1' } } })
  const r = await init(other)
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(existsSync(join(other, 'components.json'))).toBe(false)
})

test('a fresh project gets components.json, the path, the deps, the theme and the components, in that order (R41.2-R41.7)', async () => {
  const d = project()
  const r = await init(d, { components: ['button', 'card'] })
  expect(r.code).toBe(0)
  // the file is the fixture's text, not just its data
  expect(readFileSync(join(d, 'components.json'), 'utf8')).toBe(readFileSync(join(import.meta.dir, '../../../tests/fixtures/shadcn/components.json'), 'utf8'))
  expect(JSON.parse(readFileSync(join(d, 'components.json'), 'utf8'))).toEqual(JSON.parse(readFileSync(join(import.meta.dir, '../../../tests/fixtures/shadcn/components.json'), 'utf8')))
  expect(readFileSync(join(d, 'tsconfig.json'), 'utf8')).toContain('"paths": { "@/*": ["./*"] },')
  expect(r.calls).toEqual([
    ['bun', 'add', ...SHADCN_DEPS.map((d) => `${d}@${SHADCN_DEP_PINS[d]}`)],
    ['bun', 'x', `shadcn@${SHADCN_VERSION}`, 'add', 'index', '-y'],
    ['bun', 'x', `shadcn@${SHADCN_VERSION}`, 'add', 'button', 'card', '-y'],
  ])
  expect(r.lines.join('\n')).toContain('next:')
})

test('the pinned version is a constant, overridable only by an exact version (R41.6)', async () => {
  expect(SHADCN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  const d = project()
  const r = await init(d, { components: ['button'], shadcnVersion: '4.30.0' })
  expect(r.calls[1]).toContain('shadcn@4.30.0')
  for (const bad of ['latest', '4', '^4.21.4', '4.21.4; rm -rf /', '--yes']) {
    const p = project()
    const x = await init(p, { shadcnVersion: bad })
    expect([bad, x.code, x.calls.length]).toEqual([bad, 2, 0])
  }
})

test('tsconfig.json is edited as text: comments, trailing commas and layout survive (R41.4)', () => {
  const e = addAliasPath(TSCONFIG)
  expect(e.kind).toBe('added')
  if (e.kind !== 'added') return
  // The only difference is the inserted line.
  expect(e.text.replace('\n    "paths": { "@/*": ["./*"] },', '')).toBe(TSCONFIG)
  expect(e.text).toContain('// Environment setup')
  expect(e.text).toContain('/* bundler mode */')
  // And it is a valid JSONC object with the entry in the right place.
  const co = readObject(e.text).members.find((m) => m.key === 'compilerOptions')!.object!
  expect(co.members.find((m) => m.key === 'paths')!.object!.members.map((m) => m.key)).toEqual(['@/*'])
})

test('paths cases: into an existing paths, an empty one, an identical entry, another target, no compilerOptions, garbage (R41.4)', () => {
  const into = addAliasPath('{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }')
  expect(into).toEqual({ kind: 'added', text: '{ "compilerOptions": { "paths": { "@/*": ["./*"], "~/*": ["./src/*"] } } }' })
  const multi = addAliasPath('{\n  "compilerOptions": {\n    "paths": {\n      "~/*": ["./src/*"]\n    }\n  }\n}\n')
  expect(multi.kind === 'added' && multi.text).toContain('"paths": {\n      "@/*": ["./*"],\n      "~/*"')
  const empty = addAliasPath('{ "compilerOptions": { "paths": {} } }')
  expect(empty).toEqual({ kind: 'added', text: '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }' })
  expect(addAliasPath('{ "compilerOptions": { "paths": { "@/*": [ "./*" ] } } }')).toEqual({ kind: 'present' })
  expect(addAliasPath('{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')).toEqual({ kind: 'other', target: '["./src/*"]' })
  expect(addAliasPath('{ "extends": "./base.json" }').kind).toBe('unparseable')
  expect(addAliasPath('{ "compilerOptions": { ').kind).toBe('unparseable')
  expect(addAliasPath('not json').kind).toBe('unparseable')
  expect(addAliasPath('{ "compilerOptions": {} }')).toEqual({ kind: 'added', text: '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }' })
})

test('an unparseable tsconfig is not touched; the exact line to add is printed (R41.4)', async () => {
  const bad = '{ "extends": "./base.json" }'
  const d = project({ tsconfig: bad })
  const r = await init(d)
  expect(readFileSync(join(d, 'tsconfig.json'), 'utf8')).toBe(bad)
  expect(r.lines.join('\n')).toContain('"@/*": ["./*"]')
  expect(r.code).toBe(0)
})

test('an existing "@/*" with another target is left alone with a warning (R41.4)', async () => {
  const t = '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }'
  const d = project({ tsconfig: t })
  const r = await init(d)
  expect(readFileSync(join(d, 'tsconfig.json'), 'utf8')).toBe(t)
  expect(r.lines.join('\n')).toMatch(/warning: "@\/\*" already points at \["\.\/src\/\*"\]/)
})

test('dependencies already installed are skipped; only the missing ones are added (R41.5)', async () => {
  const d = project({ pkg: { name: 'a', dependencies: { '@brust/core': '1', 'lucide-react': '1' }, devDependencies: { 'tw-animate-css': '1' } } })
  const r = await init(d)
  expect(r.calls[0]).toEqual(['bun', 'add', `radix-ui@${SHADCN_DEP_PINS['radix-ui']}`, `class-variance-authority@${SHADCN_DEP_PINS['class-variance-authority']}`])
})

test('components.json is written only when absent; --force replaces it (R41.2)', async () => {
  const d = project()
  writeFileSync(join(d, 'components.json'), '{"mine":true}')
  const r = await init(d)
  expect(readFileSync(join(d, 'components.json'), 'utf8')).toBe('{"mine":true}')
  expect(r.lines.join('\n')).toContain('components.json: skipped')
  await init(d, { force: true })
  expect(readFileSync(join(d, 'components.json'), 'utf8')).toBe(componentsJson('app.css', 'neutral'))
})

test('--base-color and --css reach components.json; a bad one exits 2 (R41.2, R41.3)', async () => {
  const d = project({ css: null })
  mkdirSync(join(d, 'styles'))
  writeFileSync(join(d, 'styles/site.css'), '@import "tailwindcss";\n')
  const r = await init(d, { css: 'styles/site.css', baseColor: 'zinc' })
  expect(r.code).toBe(0)
  const cj = JSON.parse(readFileSync(join(d, 'components.json'), 'utf8'))
  expect(cj.tailwind).toMatchObject({ css: 'styles/site.css', baseColor: 'zinc' })
  for (const bad of ['../x.css', '/etc/passwd', '-rf', 'missing.css']) {
    const p = project()
    expect([bad, (await init(p, { css: bad })).code]).toEqual([bad, 2])
  }
  expect((await init(project(), { baseColor: 'Zinc; rm' })).code).toBe(2)
})

test('the CSS entry is detected, or the command asks for --css and never guesses (R41.3)', async () => {
  const none = project({ css: null })
  const r = await init(none)
  expect(r.code).toBe(2)
  expect(r.lines.join('\n')).toContain('--css')
  expect(existsSync(join(none, 'components.json'))).toBe(false)
  const two = project()
  writeFileSync(join(two, 'styles.css'), '@import "tailwindcss";\n')
  expect((await init(two)).code).toBe(2)
})

test('the theme step is skipped when app.css already has it, unless --force (R41.7)', async () => {
  const d = project({ css: THEME })
  const r = await init(d, { components: ['button'] })
  expect(r.calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['bun add', 'bun x'])
  expect(r.calls[1]).toEqual(['bun', 'x', `shadcn@${SHADCN_VERSION}`, 'add', 'button', '-y'])
  expect(r.calls.some((c) => c.includes('index'))).toBe(false)
  const f = await init(d, { components: [], force: true })
  expect(f.calls.some((c) => c.includes('index'))).toBe(true)
})

test('names are validated before anything is written or spawned; URLs must be https (R41.8)', async () => {
  for (const bad of ['Button', 'a b', '-y', '--registry', 'a;rm', '$(id)', 'a/b', 'http://x.dev/r.json', 'https://x y', '']) {
    const d = project()
    const r = await init(d, { components: ['button', bad] })
    expect([bad, r.code, r.calls.length, existsSync(join(d, 'components.json'))]).toEqual([bad, 2, 0, false])
  }
  const d = project()
  const ok = await init(d, { components: ['https://ui.example.dev/r/styles/new-york-v4/button.json', 'dialog'] })
  expect(ok.code).toBe(0)
  expect(ok.calls.at(-1)).toEqual(['bun', 'x', `shadcn@${SHADCN_VERSION}`, 'add', 'https://ui.example.dev/r/styles/new-york-v4/button.json', 'dialog', '-y'])
})

test('every spawned argv is an array of plain strings, never a shell line (R41.8)', async () => {
  const d = project()
  const r = await init(d, { components: ['button'] })
  for (const argv of r.calls) {
    expect(Array.isArray(argv)).toBe(true)
    expect(argv[0]).toBe('bun')
    for (const a of argv) expect(a).not.toMatch(/[;&|`$<>\n]/)
  }
})

test('a failing child stops the command with its exit code and names the step (R41.8)', async () => {
  const d = project()
  const r = await init(d, { components: ['button'], fail: 'index' })
  expect(r.code).toBe(7)
  expect(r.lines.join('\n')).toContain('shadcn add index failed with exit code 7')
  expect(r.calls.some((c) => c.includes('button'))).toBe(false)
  const e = await init(project(), { fail: 'add' })
  expect(e.code).toBe(7)
  expect(e.lines.join('\n')).toContain('bun add failed')
})

test('a second run changes nothing and says skipped (R41.9)', async () => {
  const d = project({ css: THEME })
  await init(d, { components: ['button'] })
  // what the first run's shadcn would have left behind
  mkdirSync(join(d, 'components/ui'), { recursive: true })
  writeFileSync(join(d, 'components/ui/button.tsx'), 'export {}')
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', dependencies: { '@brust/core': '1', ...Object.fromEntries(SHADCN_DEPS.map((x) => [x, '1'])) } }))
  const before = ['components.json', 'tsconfig.json', 'app.css', 'package.json'].map((f) => readFileSync(join(d, f), 'utf8'))
  const r = await init(d, { components: ['button'] })
  expect(r.code).toBe(0)
  expect(r.calls).toEqual([])
  expect(['components.json', 'tsconfig.json', 'app.css', 'package.json'].map((f) => readFileSync(join(d, f), 'utf8'))).toEqual(before)
  const text = r.lines.join('\n')
  for (const s of ['components.json: skipped', 'tsconfig.json: skipped', 'dependencies: skipped', 'theme: skipped', 'button: skipped']) expect(text).toContain(s)
})

test('the four packages are pinned to exact versions (F181)', () => {
  for (const v of Object.values(SHADCN_DEP_PINS)) expect(v).toMatch(/^\d+\.\d+\.\d+$/)
  expect(SHADCN_DEPS).toHaveLength(4)
})

test('a symlinked tsconfig.json is refused before any write, even with --force (F181)', async () => {
  const d = project({ tsconfig: null })
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-outside-')))
  dirs.push(outside)
  writeFileSync(join(outside, 'tsconfig.json'), TSCONFIG)
  symlinkSync(join(outside, 'tsconfig.json'), join(d, 'tsconfig.json'))
  for (const force of [false, true]) {
    const r = await init(d, { force })
    expect(r.code).toBe(2)
    expect(r.lines.join('\n')).toContain('symbolic link')
    expect(r.calls).toEqual([])
    expect(existsSync(join(d, 'components.json'))).toBe(false)
    expect(readFileSync(join(outside, 'tsconfig.json'), 'utf8')).toBe(TSCONFIG)
  }
})

test('a symlinked or dangling components.json that would be written is refused; the target is untouched (F181)', async () => {
  const d = project()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-outside-')))
  dirs.push(outside)
  symlinkSync(join(outside, 'components.json'), join(d, 'components.json')) // dangling
  const r = await init(d)
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(existsSync(join(outside, 'components.json'))).toBe(false)
  // a live link to an existing file: skipped without --force (nothing written), refused with it
  rmSync(join(d, 'components.json'))
  writeFileSync(join(outside, 'components.json'), '{}')
  symlinkSync(join(outside, 'components.json'), join(d, 'components.json'))
  expect((await init(d)).code).toBe(0)
  expect((await init(d, { force: true })).code).toBe(2)
  expect(readFileSync(join(outside, 'components.json'), 'utf8')).toBe('{}')
})

test('a registry URL whose item is already installed is skipped on a second run; --force adds it again (F181, R41.9)', async () => {
  const d = project()
  const url = 'https://ui.example.dev/r/acme-card.json'
  const first = await init(d, { components: [url] })
  expect(first.calls.at(-1)).toContain(url)
  expect(first.lines.join('\n')).toContain('third-party code')
  mkdirSync(join(d, 'components/ui'), { recursive: true })
  writeFileSync(join(d, 'components/ui/acme-card.tsx'), 'export {}')
  const second = await init(d, { components: [url] })
  expect(second.calls.some((c) => c.includes(url))).toBe(false)
  expect(second.lines.join('\n')).toContain('already in components')
  expect((await init(d, { components: [url], force: true })).calls.at(-1)).toContain(url)
})

test('a symlinked tsconfig.json that already has "@/*" is not refused and is left alone (F192)', async () => {
  const d = project({ tsconfig: null })
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-outside-')))
  dirs.push(outside)
  const withAlias = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "paths": { "@/*": ["./*"] },')
  writeFileSync(join(outside, 'tsconfig.json'), withAlias)
  symlinkSync(join(outside, 'tsconfig.json'), join(d, 'tsconfig.json'))
  const r = await init(d)
  expect(r.code).toBe(0)
  expect(r.lines.join('\n')).toContain('"@/*" is already there')
  expect(readFileSync(join(outside, 'tsconfig.json'), 'utf8')).toBe(withAlias)
})

test('the shadcn CLI is not spawned when a path it writes is, or is under, a symlink (F193)', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-outside-')))
  dirs.push(outside)
  const cases: Array<[string, (d: string) => void, string[]?]> = [
    ['components/ui as a link', (d) => { mkdirSync(join(d, 'components')); symlinkSync(outside, join(d, 'components/ui')) }],
    ['components as a link', (d) => symlinkSync(outside, join(d, 'components'))],
    ['lib as a link', (d) => symlinkSync(outside, join(d, 'lib'))],
    ['a component file as a link', (d) => { mkdirSync(join(d, 'components/ui'), { recursive: true }); symlinkSync(join(outside, 'button.tsx'), join(d, 'components/ui/button.tsx')) }, ['button']],
  ]
  for (const [label, setup, components] of cases) {
    const d = project()
    setup(d)
    const r = await init(d, { components: components ?? [], force: true })
    expect([label, r.code]).toEqual([label, 2])
    expect(r.calls).toEqual([])
    expect(r.lines.join('\n')).toContain('symbolic link')
    expect(readdirSync(outside)).toEqual([])
  }
})

test('the CLI target check follows the aliases of an existing components.json (F193)', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-outside-')))
  dirs.push(outside)
  const d = project()
  writeFileSync(join(d, 'components.json'), JSON.stringify({ aliases: { ui: '@/src/kit', components: '@/src', lib: '@/src/lib', utils: '@/src/lib/utils' } }))
  mkdirSync(join(d, 'src'))
  symlinkSync(outside, join(d, 'src/kit'))
  const r = await init(d)
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  // the same project without the link runs the CLI
  const clean = project()
  writeFileSync(join(clean, 'components.json'), JSON.stringify({ aliases: { ui: '@/src/kit' } }))
  expect((await init(clean)).code).toBe(0)
})

// F193 round 2 (Mellow F1): the CLI writes through hooks, registryDependency files, non-`@/` aliases and package.json too.
function outsideDir(): string {
  const o = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-outside-')))
  dirs.push(o)
  return o
}

test('F193 control: a clean project runs the CLI', async () => {
  const r = await init(project(), { components: ['button'] })
  expect(r.code).toBe(0)
  expect(r.calls.length).toBeGreaterThan(0)
})

test('F193 (a): a symlinked hooks directory is refused before the CLI is spawned', async () => {
  const outside = outsideDir()
  const d = project()
  symlinkSync(outside, join(d, 'hooks'))
  const r = await init(d, { components: ['sidebar'] })
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(readdirSync(outside)).toEqual([])
})

test('F193 (b): a symlinked file inside an alias directory (a registryDependency such as use-mobile) is refused', async () => {
  const outside = outsideDir()
  const d = project()
  mkdirSync(join(d, 'hooks'))
  symlinkSync(join(outside, 'use-mobile.ts'), join(d, 'hooks/use-mobile.ts'))
  const r = await init(d, { components: ['sidebar'] })
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(readdirSync(outside)).toEqual([])
})

test('F193 (c): a non-@/ alias is resolved by the tsconfig paths, and refused when it cannot be resolved', async () => {
  const outside = outsideDir()
  const d = project({ tsconfig: '{ "compilerOptions": { "paths": { "@/*": ["./*"], "~kit/*": ["./src/kit/*"] } } }' })
  writeFileSync(join(d, 'components.json'), JSON.stringify({ aliases: { ui: '~kit/ui', components: '@/components', lib: '@/lib', hooks: '@/hooks', utils: '@/lib/utils' } }))
  mkdirSync(join(d, 'src/kit'), { recursive: true })
  symlinkSync(outside, join(d, 'src/kit/ui'))
  const linked = await init(d)
  expect(linked.code).toBe(2)
  expect(linked.calls).toEqual([])
  // an alias with no tsconfig path: fail closed
  const e = project()
  writeFileSync(join(e, 'components.json'), JSON.stringify({ aliases: { ui: '~nowhere/ui', components: '@/components', lib: '@/lib', hooks: '@/hooks', utils: '@/lib/utils' } }))
  const r = await init(e)
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(r.lines.join('\n')).toContain('does not resolve')
  // an alias that escapes the project
  writeFileSync(join(e, 'components.json'), JSON.stringify({ aliases: { ui: '@/../outside', components: '@/components', lib: '@/lib', hooks: '@/hooks', utils: '@/lib/utils' } }))
  expect((await init(e)).code).toBe(2)
  expect(readdirSync(outside)).toEqual([])
})

test('F193 (d): a symlinked package.json is refused before the CLI is spawned', async () => {
  const outside = outsideDir()
  const d = project({ pkg: null })
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'a', dependencies: { '@brust/core': '^2.0.0' } }))
  symlinkSync(join(outside, 'package.json'), join(d, 'package.json'))
  const r = await init(d, { components: ['button'] })
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(JSON.parse(readFileSync(join(outside, 'package.json'), 'utf8')).name).toBe('a')
})

test('F193: a custom alias with an unreadable components.json is refused (fail closed)', async () => {
  const d = project()
  writeFileSync(join(d, 'components.json'), '{ not json')
  const r = await init(d)
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
})

test('F193: every target of a paths entry and nested entries of an alias directory are walked', async () => {
  const outside = outsideDir()
  const d = project({ tsconfig: '{ "compilerOptions": { "paths": { "@/*": ["./*"], "~k/*": ["./safe/*", "./second/*"] } } }' })
  writeFileSync(join(d, 'components.json'), JSON.stringify({ aliases: { ui: '~k/ui', components: '@/components', lib: '@/lib', hooks: '@/hooks', utils: '@/lib/utils' } }))
  mkdirSync(join(d, 'second'))
  symlinkSync(outside, join(d, 'second/ui')) // the SECOND target of the entry
  expect((await init(d)).code).toBe(2)
  const n = project()
  mkdirSync(join(n, 'components/ui/deep'), { recursive: true })
  symlinkSync(join(outside, 'x.tsx'), join(n, 'components/ui/deep/x.tsx')) // nested entry
  const r = await init(n)
  expect(r.code).toBe(2)
  expect(r.calls).toEqual([])
  expect(readdirSync(outside)).toEqual([])
})
