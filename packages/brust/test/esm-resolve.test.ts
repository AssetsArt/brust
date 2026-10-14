// F155 (shadcn S1): a bare package imported from a staged island entry resolves the way the app's own files do, so the
// bundler takes its ESM entry and tree-shakes it (recharts: -85 KB gzip on the chart page), while every target still
// bundles ONE copy of React (the old `Bun.resolveSync(appRoot)` pin guarded the dual-react trap).
import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sourceDirPlugin } from '../src/build/bundle'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const APP = join(import.meta.dir, 'fixtures/island-slots')
const cleanup: string[] = []
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-esm-')))
  cleanup.push(d)
  return d
}

function build(target: 'bun' | 'cloudflare' | 'static', cwd = APP, name = `dist-esm-${target}`) {
  // Inside the app: the static render server loads jobs.js from there (it needs the app's node_modules).
  const out = join(APP, name)
  cleanup.push(out)
  const r = Bun.spawnSync([process.execPath, CLI, 'build', 'routes.tsx', '--target', target, '--out-dir', name], {
    cwd,
    env: { ...process.env, BRUST_CORE_CF_DIR: join(import.meta.dir, 'fixtures/cf-core') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  return out
}

/** The old oracle (kept to show what it misses): the `.js` files under `dir` that carry React's element marker. It
 * cannot see two copies inside ONE chunk, and react-dom carries the same string. */
function filesWithElementMarker(dir: string): string[] {
  return jsFiles(dir).filter((f) => readFileSync(f, 'utf8').includes('react.transitional.element'))
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.m?js$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
}

/** Definitions that occur exactly once per bundled COPY of a package (minified or not; property names survive
 * minification): React's `ReactSharedInternals` object and react-dom's `Internals` object. */
const DEFINITIONS = {
  react: /\bH:\s*null,\s*A:\s*null,\s*T:\s*null,\s*S:\s*null\b/g,
  'react-dom': /\bp:\s*0,\s*findDOMNode:\s*null\b/g,
} as const

/** How many copies of react and react-dom the `.js` files under `dir` (or the one file) define, summed over files. */
function copies(path: string, only?: keyof typeof DEFINITIONS): Record<string, number> {
  const files = path.endsWith('.js') ? [path] : jsFiles(path)
  const out: Record<string, number> = {}
  for (const [pkg, re] of Object.entries(DEFINITIONS)) {
    if (only && pkg !== only) continue
    out[pkg] = files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(re)?.length ?? 0), 0)
  }
  return out
}

/** The client chunk directory of a build. */
function clientDir(out: string, target: 'bun' | 'cloudflare' | 'static'): string {
  const client = join(out, target === 'static' ? 'static/_brust/client' : 'client')
  return existsSync(client) ? client : join(out, 'client')
}

/** The app's own installed copy of a package (its real directory). */
const installed = (name: string) => dirname(realpathSync(Bun.resolveSync(`${name}/package.json`, APP)))

test('N1 (oracle sensitivity): two React copies bundled into ONE chunk are counted twice', async () => {
  const root = tmp()
  // `twin` ships its own nested React: the dual-react layout a non-deduped install produces.
  cpSync(installed('react'), join(root, 'node_modules/react'), { recursive: true })
  cpSync(installed('react'), join(root, 'node_modules/twin/node_modules/react'), { recursive: true })
  writeFileSync(join(root, 'node_modules/twin/package.json'), JSON.stringify({ name: 'twin', module: 'index.js' }))
  writeFileSync(join(root, 'node_modules/twin/index.js'), "import * as R from 'react'\nexport default R\n")
  const entry = join(root, 'entry.js')
  const write = (imports: string) => writeFileSync(entry, `${imports}\nconsole.log(a, b)\n`)
  const bundle = async () => {
    const r = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true, define: { 'process.env.NODE_ENV': '"production"' } })
    expect(r.success).toBe(true)
    expect(r.outputs.length).toBe(1)
    const f = join(root, 'out.js')
    writeFileSync(f, await r.outputs[0]!.text())
    return f
  }
  write("import * as a from 'react'\nimport b from 'twin'")
  const twice = await bundle()
  expect(filesWithElementMarker(dirname(twice)).filter((f) => f === twice)).toEqual([twice]) // the old oracle: one file, passes
  expect(copies(twice, 'react').react).toBe(2) // the definition count sees both copies
  // Control: the same chunk with one React.
  write("import * as a from 'react'\nconst b = a")
  expect(copies(await bundle(), 'react').react).toBe(1)
})

test('a package the staged file can see resolves to its ESM entry and is tree-shaken', async () => {
  const root = tmp()
  const pkg = join(root, 'node_modules/duo')
  // The recharts layout: `main` is a CJS build, `module` the ES build.
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(join(pkg, 'es6'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'duo', main: 'lib/index.js', module: 'es6/index.js', sideEffects: false }))
  writeFileSync(join(pkg, 'lib/index.js'), 'exports.used = "FROM_CJS"; exports.unused = "UNUSED_CJS"\n')
  writeFileSync(join(pkg, 'es6/index.js'), 'export const used = "FROM_ESM"\nexport const unused = "UNUSED_ESM"\n')
  mkdirSync(join(root, '.stage'), { recursive: true })
  const staged = join(root, '.stage/entry.ts')
  writeFileSync(staged, `import { used } from 'duo'\nconsole.log(used)\n`)
  const sourceOf = new Map([[staged, join(root, 'src.tsx')]])
  const out = await Bun.build({ entrypoints: [staged], target: 'browser', plugins: [sourceDirPlugin(sourceOf, root)] })
  const code = await out.outputs[0]!.text()
  expect(code).toContain('FROM_ESM')
  expect(code).not.toContain('FROM_CJS')
  expect(code).not.toContain('UNUSED_ESM')
})

test('a package only the app root sees keeps the pinned resolution (staged outside the app)', async () => {
  const app = tmp()
  const elsewhere = tmp()
  const pkg = join(app, 'node_modules/solo')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'solo', main: 'index.js' }))
  writeFileSync(join(pkg, 'index.js'), 'exports.v = "FROM_APP_ROOT"\n')
  const staged = join(elsewhere, 'entry.ts')
  writeFileSync(staged, `import { v } from 'solo'\nconsole.log(v)\n`)
  const out = await Bun.build({ entrypoints: [staged], target: 'browser', plugins: [sourceDirPlugin(new Map([[staged, join(app, 'src.tsx')]]), app)] })
  expect(await out.outputs[0]!.text()).toContain('FROM_APP_ROOT')
})

for (const target of ['bun', 'cloudflare', 'static'] as const) {
  test(`--target ${target}: the island chunks share one copy of React and of react-dom`, () => {
    const out = build(target)
    // Each package defined exactly once over every client chunk (0 would mean the markers drifted: the test then fails
    // loudly instead of passing vacuously).
    expect(copies(clientDir(out, target))).toEqual({ react: 1, 'react-dom': 1 })
    if (target === 'bun') {
      // The server jobs leave React to the worker: no copy is bundled into jobs.js.
      expect(readFileSync(join(out, 'jobs.js'), 'utf8')).toContain('from "react"')
      expect(copies(join(out, 'jobs.js'))).toEqual({ react: 0, 'react-dom': 0 })
    }
    // The Worker bundles React for SSR: one copy there too.
    if (target === 'cloudflare') expect(copies(join(out, 'cf/worker/brust-app.js'))).toEqual({ react: 1, 'react-dom': 1 })
  })
}

test('N2: a build run from a symlinked directory resolves exactly as from the real one', () => {
  // macOS: `/tmp` is `/private/tmp`, and a checkout can sit behind any symlink. `brust build` takes the app root from
  // `process.cwd()`, which is the real path, so the staged-import check (`inside(appRoot, importer)`) still holds and
  // the client chunks come out byte-identical (content-addressed names).
  const link = join(tmp(), 'app-link')
  symlinkSync(APP, link)
  const real = build('bun', APP, 'dist-esm-real')
  const viaLink = build('bun', link, 'dist-esm-link')
  const names = (out: string) => readdirSync(join(out, 'client')).sort()
  expect(names(viaLink)).toEqual(names(real))
  expect(copies(join(viaLink, 'client'))).toEqual({ react: 1, 'react-dom': 1 })
})

test('N2: a symlinked app root handed to the plugin directly falls back to the pinned resolution (safe)', async () => {
  // Only an in-process caller can pass a non-real app root (the CLI cannot, above). The importer Bun reports is real,
  // so `inside` is false and the import keeps the old pinned `Bun.resolveSync(appRoot)` answer: still ONE package,
  // the CJS `main` (no tree-shaking), never a second copy. Pinned here so a change to that fallback is seen.
  const root = tmp()
  const pkg = join(root, 'node_modules/duo')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(join(pkg, 'es6'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'duo', main: 'lib/index.js', module: 'es6/index.js', sideEffects: false }))
  writeFileSync(join(pkg, 'lib/index.js'), 'exports.used = "FROM_CJS"\n')
  writeFileSync(join(pkg, 'es6/index.js'), 'export const used = "FROM_ESM"\n')
  mkdirSync(join(root, '.stage'), { recursive: true })
  const staged = join(root, '.stage/entry.ts')
  writeFileSync(staged, `import { used } from 'duo'\nconsole.log(used)\n`)
  const link = join(tmp(), 'root-link')
  symlinkSync(root, link)
  const out = await Bun.build({ entrypoints: [staged], target: 'browser', plugins: [sourceDirPlugin(new Map([[staged, join(link, 'src.tsx')]]), link)] })
  expect(out.success).toBe(true)
  const code = await out.outputs[0]!.text()
  expect(code).toContain('FROM_CJS')
  expect(code).not.toContain('FROM_ESM')
})
