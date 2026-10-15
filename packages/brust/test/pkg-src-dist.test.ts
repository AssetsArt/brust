// F188 + F189 (R34.62): a component compiled from a package source is imported as the package's own export wherever
// React code is needed for it (an island entry, a revive hook), so the Provider's island and every revived consumer
// share the dist's ONE module instance; and a package's own imports resolve to the ES entry, not the CJS `main`.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { componentImport, sourceDirPlugin } from '../src/build/bundle'
import type { Compiled } from '../src/build/compile'
import { resolveEsm } from '../src/build/esm-resolve'
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

test('F189: resolveEsm takes the ES entry the bundler would, and falls back to the runtime resolution', () => {
  const root = tmp()
  const mk = (name: string, pj: object, files: Record<string, string>) => {
    put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...pj }))
    for (const [f, t] of Object.entries(files)) put(join(root, 'node_modules', name, f), t)
  }
  mk('duo', { main: 'lib/index.js', module: 'es6/index.js' }, { 'lib/index.js': 'exports.v=1', 'es6/index.js': 'export const v=1' })
  expect(resolveEsm('duo', root)).toBe(join(root, 'node_modules/duo/es6/index.js'))
  // `exports`: the first LISTED key whose condition holds (node's rule), per the conditions of the build.
  mk('cond', { exports: { '.': { require: './c.cjs', browser: './b.js', import: './i.js', default: './d.js' } } }, { 'c.cjs': '', 'b.js': '', 'i.js': '', 'd.js': '' })
  expect(resolveEsm('cond', root)).toBe(join(root, 'node_modules/cond/i.js'))
  expect(resolveEsm('cond', root, ['browser', 'import', 'module', 'default'])).toBe(join(root, 'node_modules/cond/b.js'))
  mk('sub', { exports: { '.': './index.js', './x': { import: './x.mjs', require: './x.cjs' } } }, { 'index.js': '', 'x.mjs': '', 'x.cjs': '' })
  expect(resolveEsm('sub/x', root)).toBe(join(root, 'node_modules/sub/x.mjs'))
  // A scoped package.
  mk('@s/p', { module: 'm.js', main: 'c.js' }, { 'm.js': 'export {}', 'c.js': '' })
  expect(resolveEsm('@s/p', root)).toBe(join(root, 'node_modules/@s/p/m.js'))
  // Unplaceable (a pattern, a target outside the package, a missing file): the runtime answer, as before.
  mk('pat', { main: 'main.js', exports: { './*': './lib/*.js' } }, { 'main.js': '', 'lib/a.js': '' })
  expect(resolveEsm('pat/a', root)).toBe(Bun.resolveSync('pat/a', root))
  mk('esc', { main: 'main.js', module: '../outside.js' }, { 'main.js': '' })
  expect(resolveEsm('esc', root)).toBe(Bun.resolveSync('esc', root))
})

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
  const out = await Bun.build({ entrypoints: [staged], target: 'browser', plugins: [sourceDirPlugin(new Map([[staged, written]]), root, [], ['browser', 'import', 'module', 'default'])] })
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
