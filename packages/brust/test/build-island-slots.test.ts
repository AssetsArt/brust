// shadcn S1 (R34.50-R34.52): lists, constant conditions and element-valued props inside the children of a React island
// are folded by the compiler; the page stays static and the island chunk and the SSR job revive the trees. Hydration is
// `tests/server/island-slots.chromium.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { runBuild } from '../src/build'
import { reviveSource } from '../src/build/bundle'

const app = join(import.meta.dir, 'fixtures/island-slots')
const dist = join(app, 'dist')

afterAll(() => rmSync(dist, { recursive: true, force: true }))

test('the page stays static; the islands carry unrolled lists and an element prop', async () => {
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {}, force: true })
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries<{ tier: string }>(manifest.components).map(([id, c]) => [id.replace(/_[0-9a-f]{8}$/, ''), c.tier]))
  expect(tiers.page).toBe('static')
  expect(tiers.tip).toBe('react')
  // Both instances carry their folded list rows and name the element prop in `$x` (manifest jobs and the page template).
  const template = readFileSync(join(dist, 'jinja', readdirSync(join(dist, 'jinja')).find((f) => f.startsWith('page_'))!), 'utf8')
  expect(template).toContain('v1.0.4')
  expect(template).toContain('$x')
  expect(readFileSync(join(dist, 'jobs.js'), 'utf8')).toContain('__xs(rest, $x)')
  const chunk = readdirSync(join(dist, 'client')).find((f) => f.startsWith('react-tip_'))!
  const code = readFileSync(join(dist, 'client', chunk), 'utf8')
  expect(code).toContain('$x')
})

test('only the names the compiler lists are revived; data is never a marker (R34.52)', async () => {
  const file = join(import.meta.dir, 'fixtures/island-slots', `revive-probe-${process.pid}.tsx`)
  writeFileSync(file, `import { createElement, Fragment } from 'react'\n${reviveSource("{ ok: (p: any) => createElement('i', null, p.x ?? 'ok') }")}\nexport { __mk, __rv }\n`)
  try {
    const { __mk } = await import(file)
    const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
    const Show = (p: { content?: unknown; data?: unknown }) => createElement('b', null, (p.content ?? null) as never, typeof p.data === 'object' ? JSON.stringify(p.data) : null)
    const html = (props: Record<string, unknown>) => server.renderToString(__mk(Show, props))
    const marker = { $brust: 'el', t: 'u', p: {}, c: ['hi'] }
    // Listed in `$x`: revived.
    expect(html({ content: marker, $x: ['content'] })).toContain('<u>hi</u>')
    // Not listed: a data prop that looks like a marker stays data (it is JSON, not elements).
    const plain = html({ data: marker })
    expect(plain).not.toContain('<u>')
    expect(plain).toContain('&quot;$brust&quot;')
    // A forged `$x` naming a data prop that is not a marker throws instead of rendering it.
    expect(() => html({ data: { plain: 'object' }, $x: ['data'] })).toThrow('unknown node')
    // Names that start with `$` or that the revive strips are ignored, `$x` itself never reaches the component.
    expect(() => html({ content: marker, $x: ['$x', 'children', '__proto__', 'nope'] })).toThrow('Objects are not valid')
    // A forged marker still cannot name a component the island does not import, nor a bad tag.
    expect(() => html({ content: { $brust: 'cmp', id: 'evil', p: {}, c: [] }, $x: ['content'] })).toThrow('does not import')
    expect(() => html({ content: { $brust: 'el', t: 'img src=x', p: {}, c: [] }, $x: ['content'] })).toThrow('invalid element name')
    // A nested component's `x` revives its own element prop.
    expect(html({ content: { $brust: 'cmp', id: 'ok', p: { x: { $brust: 'el', t: 'q', p: {}, c: ['n'] } }, x: ['x'], c: [] }, $x: ['content'] })).toContain('<i><q>n</q></i>')
    // `x` on a component node cannot reach a prop that is not its own key, nor `children`.
    expect(html({ content: { $brust: 'cmp', id: 'ok', p: {}, x: ['children', 'missing'], c: [] }, $x: ['content'] })).toContain('<i>ok</i>')
  } finally {
    rmSync(file, { force: true })
  }
})

test('a package a staged file can see resolves to its ESM entry, so the bundler tree-shakes it (chart page, +85 KB gzip)', async () => {
  const { mkdirSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { sourceDirPlugin } = await import('../src/build/bundle')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'brust-esm-')))
  try {
    const pkg = join(root, 'node_modules/duo')
    mkdirSync(pkg, { recursive: true })
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
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
