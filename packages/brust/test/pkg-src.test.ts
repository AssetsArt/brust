// F153c (R34.61, R34.62): package sources are read from the module's source map, checked against the published JS and
// written under `.brust/pkg-src`; every package that cannot be proven is refused with its reason (the compiler then keeps
// its React island). Stub packages, so the rules do not depend on a release.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { integrityGaps, PKG_SRC_DIR, preparePackageSources, skeleton } from '../src/build/pkg-src'

const cleanup: string[] = []
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

function app(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-pkgsrc-')))
  cleanup.push(d)
  return d
}

const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** A package whose ESM entry is `dist/index.mjs`, built (transpiled) from `sources` unless `dist` is given. */
function pkg(
  root: string,
  name: string,
  sources: Record<string, string | null>,
  o: { dist?: string; map?: false | 'no-content'; pj?: Record<string, unknown>; mapSources?: string[] } = {},
) {
  const dir = join(root, 'node_modules', name)
  const paths = Object.keys(sources)
  const t = new Bun.Transpiler({ loader: 'tsx' })
  const dist = o.dist ?? paths.map((p) => t.transformSync(sources[p] ?? '')).join('\n')
  put(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', exports: { '.': { import: './dist/index.mjs' } }, ...o.pj }))
  put(join(dir, 'dist/index.mjs'), dist)
  if (o.map !== false)
    put(
      join(dir, 'dist/index.mjs.map'),
      JSON.stringify({
        version: 3,
        sources: o.mapSources ?? paths.map((p) => `../${p}`),
        sourcesContent: o.map === 'no-content' ? undefined : paths.map((p) => sources[p]),
        mappings: '',
      }),
    )
  return dir
}

const LEAF = `import * as React from 'react'\nexport function Leaf(props: { tone?: string }) {\n  return <span data-tone={props.tone ?? 'plain'}>leaf</span>\n}\n`

test('a package with its source in the map is written and resolved from the app', () => {
  const root = app()
  pkg(root, 'leafy', { 'src/leaf.tsx': LEAF })
  const r = preparePackageSources(root, ['leafy'])
  const entry = r.scopes['']?.leafy
  expect(entry).toMatch(/^\.brust\/pkg-src\/p-[0-9a-f]{16}\/src\/leaf\.tsx$/)
  expect(readFileSync(join(root, entry!), 'utf8')).toBe(LEAF)
  expect(r.refused).toEqual({})
  expect(JSON.parse(readFileSync(join(root, PKG_SRC_DIR, 'index.json'), 'utf8'))).toEqual(r)
})

test('bare imports of a written package are followed in that package scope', () => {
  const root = app()
  pkg(root, 'outer', { 'src/outer.tsx': `import { Leaf } from 'leafy'\nexport function Outer() { return <Leaf /> }\n` })
  pkg(root, 'leafy', { 'src/leaf.tsx': LEAF })
  const r = preparePackageSources(root, ['outer'])
  const scope = r.scopes['']!.outer!.split('/src/')[0]!
  expect(r.scopes[scope]?.leafy).toMatch(/^\.brust\/pkg-src\/p-[0-9a-f]{16}\//)
  expect(r.dirs[scope]).toBe(join(root, 'node_modules/outer'))
})

test('the directory is rebuilt from nothing: a stale source is never left behind', () => {
  const root = app()
  put(join(root, PKG_SRC_DIR, 'stale@0.0.0-00000000/src/x.tsx'), 'export const x = 1')
  preparePackageSources(root, [])
  expect(existsSync(join(root, PKG_SRC_DIR, 'stale@0.0.0-00000000'))).toBe(false)
})

const refusedFor = (root: string, spec: string) => preparePackageSources(root, [spec]).refused['']?.[spec]

test('fail closed: each package that cannot be proven is refused with its reason', () => {
  const root = app()
  pkg(root, 'no-map', { 'src/leaf.tsx': LEAF }, { map: false })
  pkg(root, 'no-content', { 'src/leaf.tsx': LEAF }, { map: 'no-content' })
  pkg(root, 'no-esm', { 'src/leaf.tsx': LEAF }, { pj: { exports: { '.': { require: './dist/index.cjs' } } } })
  pkg(root, 'drift', { 'src/leaf.tsx': LEAF }, { dist: new Bun.Transpiler({ loader: 'tsx' }).transformSync(LEAF.replace("'plain'", "'other'")) })
  pkg(root, 'outside', { 'src/leaf.tsx': LEAF }, { mapSources: ['../../../elsewhere/leaf.tsx'] })
  pkg(root, 'lazy', { 'src/leaf.tsx': `export const load = () => import('./other')\nexport function L() { return <i /> }\n` })
  // Stub source text (never executed): a package that calls eval is refused.
  pkg(root, 'evil', { 'src/leaf.tsx': `export function L() { return <i title={eval('1')} /> }\n` })
  pkg(root, 'holey', { 'src/leaf.tsx': `import { x } from './missing'\nexport function L() { return <i title={x} /> }\n` })
  pkg(root, 'two', { 'src/a.tsx': LEAF, 'src/b.tsx': LEAF })
  expect(refusedFor(root, 'no-map')).toBe('no source map for the ESM entry')
  expect(refusedFor(root, 'no-content')).toContain('no TypeScript sources')
  expect(refusedFor(root, 'no-esm')).toContain('no ESM entry')
  expect(refusedFor(root, 'drift')).toContain('do not match the published')
  expect(refusedFor(root, 'outside')).toContain('outside the package')
  expect(refusedFor(root, 'lazy')).toContain('dynamic-import')
  expect(refusedFor(root, 'evil')).toContain('eval')
  expect(refusedFor(root, 'holey')).toContain('does not carry')
  expect(refusedFor(root, 'two')).toContain('none is the entry')
  expect(refusedFor(root, 'not-installed')).toBe('not installed')
  expect(refusedFor(root, 'leafy/sub')).toBe('a package subpath import is not followed')
  // React and brust are never followed (no entry, no refusal).
  const r = preparePackageSources(root, ['react', '@brust/core', 'lucide-react'])
  expect(r).toEqual({ scopes: {}, refused: {}, dirs: {} })
})

test('a multi-module source map names its entry by `source` or as the one unimported module', () => {
  const root = app()
  const dist = new Bun.Transpiler({ loader: 'tsx' }).transformSync(LEAF)
  pkg(root, 'multi', { 'src/index.tsx': `export { Leaf } from './leaf'\n`, 'src/leaf.tsx': LEAF }, { dist })
  expect(preparePackageSources(root, ['multi']).scopes['']?.multi).toMatch(/\/src\/index\.tsx$/)
  pkg(root, 'named', { 'src/a.tsx': LEAF, 'src/b.tsx': LEAF }, { dist, pj: { source: './src/b.tsx' } })
  expect(preparePackageSources(root, ['named']).scopes['']?.named).toMatch(/\/src\/b\.tsx$/)
  // A published file the check cannot parse is a refusal, never a build crash.
  pkg(root, 'broken', { 'src/leaf.tsx': LEAF }, { dist: 'export function {' })
  expect(refusedFor(root, 'broken')).toContain('integrity check could not read')
})

test('integrity reads literals and names, not syntax: esbuild artefacts pass, a changed literal or name does not', () => {
  const src = [{ path: 'src/a.tsx', text: `const Label = forwardRef(function Label(p: any, r: any) { return <b data-x="1">{p.n ?? undefined}</b> })\nexport { Label }` }]
  const dist = `"use client";\nvar __name = (t, v) => t;\nimport { jsx } from "react/jsx-runtime";\nvar Label = forwardRef(/* @__PURE__ */ __name(function Label2(p, r) { return jsx("b", { "data-x": "1", children: p.n ?? void 0 }); }, "Label"));\nexport { Label };`
  expect(integrityGaps(src, dist)).toEqual([])
  expect(integrityGaps(src, dist.replace('"data-x": "1"', '"data-x": "2"')).join()).toContain('literal "1"')
  expect(integrityGaps(src, dist.replaceAll('p.n', 'p.m')).join()).toContain('name `n`')
  expect(skeleton('a = `x${b}y` + 0x10').strings).toEqual(new Set(['x', 'y', '#16']))
})

test('review F1: a hostile package.json name or version never moves a write out of .brust/pkg-src', () => {
  const root = app()
  const outside = join(root, '..', `escape-${Date.now()}`)
  cleanup.push(outside)
  for (const [spec, pj] of [
    ['evil-ver', { version: `1/../../../../${outside.split('/').pop()}` }],
    ['evil-name', { name: `a/../../../../../${outside.split('/').pop()}/b` }],
    ['evil-abs', { name: outside, version: outside }],
  ] as const) {
    pkg(root, spec, { 'src/leaf.tsx': LEAF }, { pj })
    const r = preparePackageSources(root, [spec])
    const entry = r.scopes['']?.[spec]
    expect(entry).toMatch(/^\.brust\/pkg-src\/p-[0-9a-f]{16}\/src\/leaf\.tsx$/)
    expect(realpathSync(join(root, entry!)).startsWith(join(root, PKG_SRC_DIR) + '/')).toBe(true)
  }
  expect(existsSync(outside)).toBe(false)
})

test('a .brust or .brust/pkg-src that links out of the app is refused before anything is removed (F163)', () => {
  for (const linked of ['pkg-src', 'brust']) {
    const root = app()
    const outside = app()
    put(join(outside, 'sentinel.txt'), 'keep me')
    put(join(outside, 'pkg-src', 'sentinel.txt'), 'keep me too')
    if (linked === 'brust') {
      symlinkSync(outside, join(root, '.brust'))
    } else {
      mkdirSync(join(root, '.brust'), { recursive: true })
      symlinkSync(join(outside, 'pkg-src'), join(root, PKG_SRC_DIR))
    }
    expect(() => preparePackageSources(root, [])).toThrow('resolves outside the app root')
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep me')
    expect(readFileSync(join(outside, 'pkg-src', 'sentinel.txt'), 'utf8')).toBe('keep me too')
  }
  // A dangling link is refused as well, and a plain directory still rebuilds.
  const root = app()
  mkdirSync(join(root, '.brust'), { recursive: true })
  symlinkSync(join(root, 'nowhere'), join(root, PKG_SRC_DIR))
  expect(() => preparePackageSources(root, [])).toThrow('resolves outside the app root')
  rmSync(join(root, PKG_SRC_DIR), { force: true })
  mkdirSync(join(root, PKG_SRC_DIR), { recursive: true })
  expect(() => preparePackageSources(root, [])).not.toThrow()
})

// ---------------------------------------------------------------------------------------------------------------
// Wave A step 0 (P1, P2): a bundle of several sources with no entry in the map, and the `unstable_` export aliases.

const HOOK = `import * as React from 'react'\nexport function useThing(x: number) {\n  return React.useState(x)\n}\n`
const REDUCER = `import * as R2 from 'react'\nexport function useThingReducer(x: number) {\n  return R2.useReducer((s: number) => s, x)\n}\n`
const clause = (body: string) => `export { ${body} }\n`
const distOf = (srcs: string[], exportClause: string) => `${srcs.map((s) => new Bun.Transpiler({ loader: 'tsx' }).transformSync(s).replace(/^export /gm, '')).join('\n')}\n${exportClause}`

test('P1: a bundle of several sources is entered through a barrel written from the published export clause', () => {
  const root = app()
  pkg(root, 'bundle', { 'src/thing.tsx': HOOK, 'src/thing-reducer.tsx': REDUCER }, { dist: distOf([HOOK, REDUCER], clause('useThing, useThingReducer')) })
  const r = preparePackageSources(root, ['bundle'])
  const entry = r.scopes['']?.bundle
  expect(r.refused).toEqual({})
  expect(entry).toMatch(/\/src\/index\.ts$/)
  expect(readFileSync(join(root, entry!), 'utf8')).toBe(`export { useThing } from './thing'\nexport { useThingReducer } from './thing-reducer'\n`)
})

test('P1 bounds: an alias, an unexplained source, a doubly declared name, a default or a star export are refused', () => {
  const root = app()
  const sources = { 'src/thing.tsx': HOOK, 'src/thing-reducer.tsx': REDUCER }
  pkg(root, 'aliased', sources, { dist: distOf([HOOK, REDUCER], clause('useThing, useThingReducer as other')) })
  pkg(root, 'unexplained', sources, { dist: distOf([HOOK, REDUCER], clause('useThing')) })
  pkg(root, 'double', { 'src/a.tsx': HOOK, 'src/b.tsx': HOOK }, { dist: distOf([HOOK], clause('useThing')) })
  pkg(root, 'defaulted', sources, { dist: distOf([HOOK, REDUCER], `${clause('useThing, useThingReducer')}export default 1\n`) })
  pkg(root, 'starred', sources, { dist: distOf([HOOK, REDUCER], `${clause('useThing, useThingReducer')}export * from './x'\n`) })
  pkg(root, 'two-clauses', sources, { dist: distOf([HOOK, REDUCER], `${clause('useThing')}${clause('useThingReducer')}`) })
  for (const name of ['aliased', 'unexplained', 'double', 'defaulted', 'starred', 'two-clauses']) expect([name, refusedFor(root, name)]).toEqual([name, expect.stringContaining('none is the entry')])
  // Every source still goes through the integrity compare: a changed literal in one of them refuses the package.
  pkg(root, 'drifted', sources, { dist: distOf([HOOK, REDUCER.replace('useReducer', 'useState')], clause('useThing, useThingReducer')) })
  expect(refusedFor(root, 'drifted')).toContain('do not match the published')
})

const ALIAS_SRC = `import * as React from 'react'\nfunction Inner() {\n  return <i />\n}\nexport { Inner as Provider }\n`
const aliasDist = (pubClause: string, from = ALIAS_SRC) => `${new Bun.Transpiler({ loader: 'tsx' }).transformSync(from).replace(/^export \{.*\};?\s*$/m, '')}\nexport { ${pubClause} }\n`

test('P2: an export alias the published file spells unstable_<alias> over the SAME local binding is not a difference', () => {
  expect(integrityGaps([{ path: 'src/a.tsx', text: ALIAS_SRC }], aliasDist('Inner as unstable_Provider'))).toEqual([])
  // The alias is also fine when the published file keeps it as written.
  expect(integrityGaps([{ path: 'src/a.tsx', text: ALIAS_SRC }], aliasDist('Inner as Provider'))).toEqual([])
})

test('P2 bounds: any other alias difference stays a refusal (pinned)', () => {
  const src = [{ path: 'src/a.tsx', text: ALIAS_SRC }]
  // A different prefix, a different alias, another local binding, no export at all, a suffix: all differences.
  for (const pub of ['Inner as stable_Provider', 'Inner as unstable_Other', 'Inner as Unstable_Provider', 'Inner as unstable_Provider2', 'Inner']) {
    expect(integrityGaps(src, aliasDist(pub)).join(), pub).toContain('name `Provider`')
  }
  const other = ALIAS_SRC.replace('function Inner() {', 'function Elsewhere() {\n  return <b />\n}\nfunction Inner() {')
  expect(integrityGaps([{ path: 'src/a.tsx', text: other }], aliasDist('Elsewhere as unstable_Provider', other)).join()).toContain('name `Provider`')
  // The alias name is not hidden when the source USES it as an ordinary name too.
  const uses = ALIAS_SRC.replace('return <i />', 'return <i title={String(Provider)} />')
  expect(integrityGaps([{ path: 'src/a.tsx', text: uses }], aliasDist('Inner as unstable_Provider')).join()).toContain('name `Provider`')
})
