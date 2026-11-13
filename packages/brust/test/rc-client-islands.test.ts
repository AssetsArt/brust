// F548: `[build] islands` (an exposed React component built as an island no route renders), the compile API placing a
// listed island as a client-only host (`artifact.islands`), and a recursive tree's React leaf linked through the
// component that prints the tree. Served: tests/server/rc-client-islands.chromium.test.ts.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { parseIslands } from '../src/build/config'
import { compileComponent } from '../src/compile'

const app = join(import.meta.dir, 'fixtures/rc-client-islands')
const dist = join(app, 'dist')
const bad = join(import.meta.dir, `fixtures/rc-client-islands-bad-${process.pid}`)

beforeAll(async () => {
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {}, force: true })
}, 120_000)
afterAll(() => {
  rmSync(dist, { recursive: true, force: true })
  rmSync(join(app, '.brust'), { recursive: true, force: true })
  rmSync(bad, { recursive: true, force: true })
})

test('parseIslands: path#Export of an exposed module, normalised; anything else is a config error', () => {
  const expose = ['shop/sdk.tsx']
  expect(parseIslands('brust.toml', app, expose, undefined)).toEqual([])
  expect(parseIslands('brust.toml', app, expose, ['./shop/sdk.tsx#Motion', 'shop/sdk.tsx#Motion'])).toEqual(['shop/sdk.tsx#Motion'])
  for (const [raw, msg] of [
    ['shop/sdk.tsx', 'must be "path#Export"'],
    ['shop/sdk.tsx#', 'must be "path#Export"'],
    ['shop/sdk.tsx#not-a-name', 'must be "path#Export"'],
    ['Leaf.tsx#Leaf', 'is not in build.expose'],
  ] as const)
    expect(() => parseIslands('brust.toml', app, expose, [raw])).toThrow(msg)
  expect(() => parseIslands('brust.toml', app, expose, 'shop/sdk.tsx#Motion')).toThrow('must be an array')
})

test('the build: the listed island has its chunk and manifest entry, no jobs.js entry; runtime.islands names it', () => {
  const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const id = Object.keys(m.runtime.islands)[0]!
  expect(m.runtime.islands).toEqual({ [id]: 'shop/sdk.tsx#Motion' })
  expect(id).toMatch(/^motion_[0-9a-f]{8}$/)
  expect(m.components[id].tier).toBe('react')
  expect(m.components[id].client).toMatch(new RegExp(`^client/react-${id}-[0-9a-f]+\\.js$`))
  expect(readFileSync(join(dist, 'jobs.js'), 'utf8')).not.toContain(id)
  // the recursive tree's React leaf: the tree is static, the component that prints it links the leaf (client-only)
  const tree = Object.keys(m.components).find((k) => k.startsWith('tree_'))!
  const menu = Object.keys(m.components).find((k) => k.startsWith('menu_'))!
  const leaf = Object.keys(m.components).find((k) => k.startsWith('leaf_'))!
  expect(m.components[tree].tier).toBe('static')
  expect(m.components[menu].tier).toBe('static')
  expect(m.components[menu].children).toEqual([{ id: leaf, instances: 'static', props: {} }])
})

test('a listed export that is not a React component, or does not exist, is a build error naming it', async () => {
  cpSync(app, bad, { recursive: true, filter: (p) => !p.includes('/dist') && !p.includes('/.brust') })
  for (const [entry, msg] of [
    ['shop/sdk.tsx#Nope', 'has no component export Nope'],
    ['shop/plain.tsx#Plain', 'not React'],
  ] as const) {
    writeFileSync(join(bad, 'shop/plain.tsx'), 'export function Plain({ t }: { t: string }) {\n  return <b>{t}</b>\n}\n')
    writeFileSync(join(bad, 'brust.toml'), `[build]\nexpose = ["shop/sdk.tsx", "shop/plain.tsx"]\nislands = [${JSON.stringify(entry)}]\n`)
    const err = await runBuild({ appRoot: bad, entry: 'routes.tsx', outDir: join(bad, 'dist'), log: () => {}, force: true }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err?.message).toContain(entry)
    expect(err?.message).toContain(msg)
  }
}, 120_000)

test('compileComponent: a listed island is a client-only host in artifact.islands; an unlisted React export is refused', async () => {
  const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const id = Object.keys(m.runtime.islands)[0]!
  const promo = "import { Motion } from '../shop/sdk'\nexport default function Promo({ label }: { label: string }) {\n  return <section><h3>{label}</h3><Motion label={label} /></section>\n}\n"
  const r = await compileComponent({ source: promo, filename: 'el/Promo.tsx', appRoot: app, dist })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  expect(r.artifact.islands).toEqual([id])
  expect(r.artifact.tier).toBe('static')
  expect(r.artifact.features).toContain('island')
  expect(r.artifact.jinja).toContain(`<brust-island style="display:contents" data-id="${id}" x-props='{{ {"label": label} | json_attr }}'></brust-island>`)
  expect(r.artifact.jinja).not.toContain('_ssr_')
  const unlisted = "import { Unlisted } from '../shop/sdk'\nexport default function Bad({ label }: { label: string }) {\n  return <Unlisted label={label} />\n}\n"
  const b = await compileComponent({ source: unlisted, filename: 'el/Bad.tsx', appRoot: app, dist })
  expect(b.ok).toBe(false)
  expect(b.diagnostics.filter((d) => d.class === 'error').map((d) => d.rule).sort()).toEqual(['runtime-jobs', 'runtime-jobs', 'runtime-tier'])
  // a source with no island compiles as before: no `islands` key
  const plain = await compileComponent({ source: 'export default function N({ t }: { t: string }) {\n  return <b>{t}</b>\n}\n', filename: 'el/N.tsx', appRoot: app, dist })
  expect(plain.ok && !('islands' in plain.artifact)).toBe(true)
}, 60_000)
