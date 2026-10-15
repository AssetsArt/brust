// F188 + F189 (R34.62): a component compiled from a package source is imported as the package's own export wherever
// React code is needed for it (an island entry, a revive hook), so the Provider's island and every revived consumer
// share the dist's ONE module instance; and a package's own imports resolve to the ES entry, not the CJS `main`.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { componentImport, sourceDirPlugin } from '../src/build/bundle'
import type { Compiled } from '../src/build/compile'
import { PRODUCTION } from '../src/build/bundle'
import { resolveNative } from '../src/build/esm-resolve'
import { preparePackageSources } from '../src/build/pkg-src'

const cleanup: string[] = []
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-dist-')))
  cleanup.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
type Ref = { source: string; export: string; member?: string[] }
const comp = (file: string, o: { external?: Ref; dist?: Ref; export?: string }) => ({ file, ir: { external: o.external, dist: o.dist, export: o.export } }) as unknown as Compiled

test('a component with a published spelling imports the package export, not its source file', () => {
  const src = '/app/.brust/pkg-src/p-1/src/item.tsx'
  expect(componentImport(comp(src, { dist: { source: 'ctxdist', export: 'Item' }, export: 'Item' }), 'N0')).toBe('import { Item as N0 } from "ctxdist"')
  expect(componentImport(comp(src, { dist: { source: 'ctxdist', export: 'default' } }), 'N0')).toBe('import N0 from "ctxdist"')
  // The member shape (`<Dialog.Title>`): read off the export, as for an external island.
  const m = componentImport(comp(src, { dist: { source: 'radix-ui', export: 'Dialog', member: ['Title'] } }), 'N0')
  expect(m).toContain('import { Dialog as N0__ns } from "radix-ui"')
  expect(m).toContain('const N0 = N0__ns.Title')
  // No spelling (reached only inside a package): today's import of the written source.
  expect(componentImport(comp(src, { export: 'Item' }), 'N0')).toBe(`import { Item as N0 } from ${JSON.stringify(src)}`)
  // An external island is unchanged, and wins.
  expect(componentImport(comp('/x.tsx', { external: { source: 'lucide-react', export: 'Heart' }, dist: { source: 'other', export: 'X' } }), 'C')).toBe('import { Heart as C } from "lucide-react"')
})

/** A package whose Provider and consumer share a module-level context (`ctx.js`), written once in the dist. */
function ctxApp() {
  const root = tmp()
  const pkg = join(root, 'node_modules/ctxdist')
  put(join(pkg, 'package.json'), JSON.stringify({ name: 'ctxdist', type: 'module', module: 'dist/index.js', sideEffects: false }))
  put(join(pkg, 'dist/ctx.js'), 'export const Ctx = { id: "UNIQUE_CONTEXT_MARK" }\n')
  put(join(pkg, 'dist/index.js'), 'import { Ctx } from "./ctx.js"\nexport const Root = () => Ctx\nexport const Item = () => Ctx\n')
  return { root, pkg }
}

let n = 0
async function chunks(root: string, entries: Record<string, string>, sourceOf: Map<string, string>): Promise<string> {
  const outdir = join(root, `out${n++}`)
  mkdirSync(join(root, '.stage'), { recursive: true })
  const files = Object.entries(entries).map(([name, text]) => {
    const f = join(root, '.stage', `${name}.ts`)
    writeFileSync(f, text)
    return f
  })
  for (const f of files) sourceOf.set(f, join(root, 'src.tsx'))
  const out = await Bun.build({ entrypoints: files, splitting: true, outdir, target: 'browser', plugins: [sourceDirPlugin(sourceOf, root)] })
  expect(out.success, out.logs.join('\n')).toBe(true)
  return readdirSync(outdir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(outdir, f), 'utf8'))
    .join('\n')
}
const count = (code: string, mark: string) => code.split(mark).length - 1

test('F188: the Provider island and a revived consumer share one module instance', async () => {
  const { root } = ctxApp()
  const src = join(root, '.brust/pkg-src/p-1/src')
  // The map source of the consumer: its own copy of the context module, as the written source has.
  put(join(src, 'ctx.js'), 'export const Ctx = { id: "UNIQUE_CONTEXT_MARK" }\n')
  put(join(src, 'item.js'), 'import { Ctx } from "./ctx.js"\nexport const Item = () => Ctx\n')
  const provider = comp('/x.tsx', { external: { source: 'ctxdist', export: 'Root' } })
  const sourceOf = new Map<string, string>()
  // Before: the consumer is imported from the written source (a second copy of the context).
  const before = await chunks(root, {
    a: `${componentImport(provider, 'P')}\nconsole.log(P)`,
    b: `${componentImport(comp(join(src, 'item.js'), { export: 'Item' }), 'N')}\nconsole.log(N)`,
  }, sourceOf)
  expect(count(before, 'UNIQUE_CONTEXT_MARK')).toBe(2)
  // After: the consumer is the package export, and the splitting build keeps ONE module instance for both.
  const after = await chunks(root, {
    c: `${componentImport(provider, 'P')}\nconsole.log(P)`,
    d: `${componentImport(comp(join(src, 'item.js'), { export: 'Item', dist: { source: 'ctxdist', export: 'Item' } }), 'N')}\nconsole.log(N)`,
  }, new Map())
  expect(count(after, 'UNIQUE_CONTEXT_MARK')).toBe(1)
})

/** Independent oracle: a REAL file in the app that imports `spec`, built by the same bundler for the same target. */
async function nativePick(root: string, spec: string, target: 'bun' | 'browser', define: Record<string, string>): Promise<string> {
  const f = join(root, `native-${target}-${spec.replace(/\W/g, '_')}.ts`)
  writeFileSync(f, `import ${JSON.stringify(spec)}\n`)
  let got = ''
  await Bun.build({
    entrypoints: [f],
    target,
    define,
    plugins: [{ name: 'o', setup: (b) => void b.onLoad({ filter: /node_modules/ }, (a) => ((got = a.path), { contents: '', loader: 'js' })) }],
  })
  return got
}

// The matrix of package layouts the bundler resolves differently per target (Mellow F1): the pick of resolveNative must
// equal the pick of a real import in both targets, whatever the layout.
const MATRIX: Record<string, [object, Record<string, string>]> = {
  dual: [{ main: 'lib.js', module: 'es.js' }, { 'lib.js': 'exports.v=1', 'es.js': 'export const v=1' }],
  'cond-node': [{ exports: { node: './n.js', import: './i.js' } }, { 'n.js': '', 'i.js': '' }],
  'cond-bun': [{ exports: { bun: './b.js', import: './i.js' } }, { 'b.js': '', 'i.js': '' }],
  'cond-module': [{ exports: { module: './m.js', import: './i.js' } }, { 'm.js': '', 'i.js': '' }],
  'cond-development': [{ exports: { development: './d.js', import: './i.js' } }, { 'd.js': '', 'i.js': '' }],
  'cond-browser': [{ exports: { browser: './b.js', import: './i.js', default: './d.js' } }, { 'b.js': '', 'i.js': '', 'd.js': '' }],
  'cond-require-first': [{ exports: { require: './c.cjs', import: './i.js' } }, { 'c.cjs': '', 'i.js': '' }],
  'cond-nested-fallthrough': [{ exports: { import: { worker: './w.js' }, default: './d.js' } }, { 'w.js': '', 'd.js': '' }],
  'cond-nested': [{ exports: { '.': { import: { default: './i.js' }, require: './r.js' } } }, { 'i.js': '', 'r.js': '' }],
  'field-browser-string': [{ module: 'm.js', browser: 'b.js', main: 'c.js' }, { 'm.js': '', 'b.js': '', 'c.js': '' }],
  'field-browser-map': [{ main: 'm.js', browser: { './m.js': './b.js' } }, { 'm.js': '', 'b.js': '' }],
  'only-main': [{ main: 'main.js' }, { 'main.js': '' }],
  'sub/x': [{ exports: { '.': './index.js', './x': { import: './x.mjs', require: './x.cjs' } } }, { 'index.js': '', 'x.mjs': '', 'x.cjs': '' }],
  'pattern/a': [{ exports: { './*': './lib/*.js' } }, { 'lib/a.js': '' }],
  '@s/scoped': [{ module: 'm.js', main: 'c.js' }, { 'm.js': '', 'c.js': '' }],
}

for (const target of ['bun', 'browser'] as const) {
  test(`F189: resolveNative equals the bundler's own pick for every layout (target ${target})`, async () => {
    const root = tmp()
    const specs: string[] = []
    for (const [spec, [pj, files]] of Object.entries(MATRIX)) {
      const name = spec.startsWith('@') ? spec : spec.split('/')[0]!
      put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...pj }))
      for (const [f, t] of Object.entries(files)) put(join(root, 'node_modules', name, f), t)
      specs.push(spec)
    }
    for (const spec of specs) {
      const want = await nativePick(root, spec, target, PRODUCTION)
      expect(want, `${spec}: the oracle found nothing`).not.toBe('')
      expect(resolveNative(spec, root, target, PRODUCTION), spec).toBe(want)
    }
    // And once without any define, as the first version of this test ran.
    for (const spec of specs) expect(resolveNative(spec, root, target), `${spec} (no define)`).toBe(await nativePick(root, spec, target, {}))
    // An unresolvable specifier falls back to the runtime answer (which throws its own error).
    expect(() => resolveNative('not-installed', root, target, PRODUCTION)).toThrow()
  })
}

// The ruling's extra case: a package exposing `development` AND `production`/`default`. Bun's bundler flips the pick with
// NODE_ENV, so the probe must carry the build's define, per mode (`brust build` is production, `brust dev` development).
for (const target of ['bun', 'browser'] as const) {
  test(`F189: a development/production package resolves per mode as the bundler does (target ${target})`, async () => {
    const root = tmp()
    put(join(root, 'node_modules/modal/package.json'), JSON.stringify({ name: 'modal', exports: { development: './dev.js', production: './prod.js', default: './def.js' } }))
    for (const f of ['dev.js', 'prod.js', 'def.js']) put(join(root, 'node_modules/modal', f), '')
    const modes = { production: { 'process.env.NODE_ENV': '"production"' }, development: { 'process.env.NODE_ENV': '"development"' } }
    const picks: Record<string, string> = {}
    for (const [mode, define] of Object.entries(modes)) {
      const want = await nativePick(root, 'modal', target, define)
      expect(resolveNative('modal', root, target, define), mode).toBe(want)
      picks[mode] = want
    }
    // The two modes differ (else this proves nothing), and the production build never gets the development export.
    expect(picks.production).not.toBe(picks.development)
    expect(picks.production).not.toContain('dev.js')
  })
}

test('F189: what a package source imports resolves to the dependency ES entry, in the browser build too', async () => {
  const root = tmp()
  // `host` ships its own private `dup` (CJS `main`, ES `module`): invisible from the app, so the plugin resolves it.
  const host = join(root, 'node_modules/host')
  const sources = { 'src/index.tsx': 'import { v } from "dup"\nexport const X = () => v\n' }
  const dist = new Bun.Transpiler({ loader: 'tsx' }).transformSync(sources['src/index.tsx'])
  put(join(host, 'package.json'), JSON.stringify({ name: 'host', version: '1.0.0', exports: { '.': { import: './dist/index.mjs' } } }))
  put(join(host, 'dist/index.mjs'), dist)
  put(join(host, 'dist/index.mjs.map'), JSON.stringify({ version: 3, sources: ['../src/index.tsx'], sourcesContent: [sources['src/index.tsx']], mappings: '' }))
  const dup = join(host, 'node_modules/dup')
  put(join(dup, 'package.json'), JSON.stringify({ name: 'dup', main: 'lib/index.js', module: 'es6/index.js', sideEffects: false }))
  put(join(dup, 'lib/index.js'), 'exports.v = "FROM_CJS"\n')
  put(join(dup, 'es6/index.js'), 'export const v = "FROM_ESM"\n')
  const map = preparePackageSources(root, ['host'])
  const written = join(root, map.scopes['']!.host!)
  // An artifact compiled from the package's source imports what the package sees (the `pkg` branch).
  mkdirSync(join(root, '.stage'), { recursive: true })
  const staged = join(root, '.stage/native.ts')
  writeFileSync(staged, 'import { v } from "dup"\nconsole.log(v)\n')
  const out = await Bun.build({ entrypoints: [staged], target: 'browser', plugins: [sourceDirPlugin(new Map([[staged, written]]), root, [], 'browser')] })
  expect(out.success).toBe(true)
  const code = await out.outputs[0]!.text()
  expect(code).toContain('FROM_ESM')
  expect(code).not.toContain('FROM_CJS')
  // The written source imported as itself (the `own` branch).
  const direct = await Bun.build({ entrypoints: [written], target: 'browser', plugins: [sourceDirPlugin(new Map(), root)] })
  expect(direct.success, direct.logs.join('\n')).toBe(true)
  const dcode = await direct.outputs[0]!.text()
  expect(dcode).toContain('FROM_ESM')
  expect(dcode).not.toContain('FROM_CJS')
})
