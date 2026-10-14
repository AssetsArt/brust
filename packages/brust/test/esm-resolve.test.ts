// F155 (shadcn S1): a bare package imported from a staged island entry resolves the way the app's own files do, so the
// bundler takes its ESM entry and tree-shakes it (recharts: -85 KB gzip on the chart page), while every target still
// bundles ONE copy of React (the old `Bun.resolveSync(appRoot)` pin guarded the dual-react trap).
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function build(target: 'bun' | 'cloudflare' | 'static') {
  // Inside the app: the static render server loads jobs.js from there (it needs the app's node_modules).
  const out = join(APP, `dist-esm-${target}`)
  cleanup.push(out)
  const r = Bun.spawnSync([process.execPath, CLI, 'build', 'routes.tsx', '--target', target, '--out-dir', out], {
    cwd: APP,
    env: { ...process.env, BRUST_CORE_CF_DIR: join(import.meta.dir, 'fixtures/cf-core') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  return out
}

/** The `.js` files under `dir` that DEFINE React (the element marker is a string literal in react's own code). */
function reactCopies(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !/\.m?js$/.test(e.name)) continue
    const f = join(e.parentPath, e.name)
    if (readFileSync(f, 'utf8').includes('react.transitional.element')) out.push(f)
  }
  return out
}

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
  test(`--target ${target}: the island chunks share one copy of React`, () => {
    const out = build(target)
    const client = join(out, target === 'static' ? 'static/_brust/client' : 'client')
    const dir = existsSync(client) ? client : join(out, 'client')
    expect(reactCopies(dir).length).toBe(1)
    if (target === 'bun') expect(readFileSync(join(out, 'jobs.js'), 'utf8')).toContain('from "react"')
  })
}
