import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompiledComponent } from '../native/index.js'
import { runBuild } from '../src/build'
import { type Compiled, compileApp, ROLE, type Role, replaces, type Seen } from '../src/build/compile'
import { scanRoutes } from '../src/build/scan'
import { flattenRoutes } from '../src/routes'

const app = join(import.meta.dir, 'fixtures/app')

/** scan + flatten + compileApp: the front half of `brust build`. */
async function buildFixture(dir: string) {
  const { routes, componentFile } = await scanRoutes(join(dir, 'routes.tsx'))
  return compileApp({
    appRoot: dir,
    leaves: flattenRoutes(routes).leaves,
    componentFile,
    runtimeImport: '/_brust/client/runtime-test.js',
    serverOnly: [],
    log: () => {},
  })
}

test('scanRoutes maps every Component to its .tsx file', async () => {
  const { routes, componentFile } = await scanRoutes(join(app, 'routes.tsx'))
  const { leaves } = flattenRoutes(routes)
  expect(leaves.flatMap((l) => l.chain.map((r) => componentFile.get(r.Component!)?.split('/').pop()))).toEqual([
    'AppLayout.tsx',
    'HomePage.tsx',
    'AppLayout.tsx',
    'ItemPage.tsx',
  ])
})

test('compileApp compiles each file once, through lowering, with children', async () => {
  const { compiled, routeComponent } = await buildFixture(app)
  expect([...compiled.keys()].map((i) => i.split('_')[0]).sort()).toEqual(['appLayout', 'homePage', 'itemPage', 'priceRow', 'team'])
  const item = compiled.get(routeComponent.get('r2')!)!
  // `JobKind` is externally tagged: unit variant = string, `Ssr{..}` = one-key object.
  // biome-ignore lint/suspicious/noExplicitAny: IR JSON
  expect(item.ir.jobs.map((j: any) => [typeof j.kind === 'string' ? j.kind : Object.keys(j.kind)[0], j.outputs])).toEqual([
    ['Precompute', ['_s1']],
    ['Ssr', [expect.stringMatching(/^_ssr_team_/)]],
  ])
  expect(item.ir.instances[0]!.loops).toEqual(['item.rows'])
  expect(item.ir.use_id_slots).toBe(1)
  expect(compiled.get(routeComponent.get('r0')!)!.ir.uses_outlet).toBe(true)
  expect(item.clientJs).toBeFalsy() // F70: ItemPage is static, no client chunk
  const layout = [...compiled.entries()].find(([id]) => id.startsWith('appLayout_'))![1]
  expect(layout.clientJs).toContain('from "/_brust/client/runtime-test.js"')
})

test('outlet-outside-layout, unresolvable Component and lowering Error are build errors (run, not read)', async () => {
  const bad = join(import.meta.dir, 'fixtures/bad')
  await expect(buildFixture(join(bad, 'outlet-leaf'))).rejects.toMatchObject({ rule: 'outlet-outside-layout' })
  await expect(buildFixture(join(bad, 'inline-component'))).rejects.toMatchObject({ rule: 'component-source' })
  await expect(buildFixture(join(bad, 'nested-instance'))).rejects.toMatchObject({ rule: 'nested-instance' })
})

test('runBuild refuses nested and duplicate catch-alls (defineRoutes or a plain array)', async () => {
  const bad = join(import.meta.dir, 'fixtures/bad')
  const out = mkdtempSync(join(tmpdir(), 'brust-catchall-'))
  try {
    for (const [dir, rule] of [
      ['nested-catch-all', 'nested-catch-all'],
      ['duplicate-catch-all', 'duplicate-catch-all'],
    ] as const) {
      const d = join(bad, dir)
      await expect(runBuild({ appRoot: d, entry: 'routes.tsx', outDir: out, log: () => {} })).rejects.toMatchObject({ rule })
      expect(existsSync(join(out, 'manifest.json'))).toBe(false)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 60_000)

// F75: List is a stateless route root on /a and a linked child of the stateful Board on /b.
const sharedRoot = join(import.meta.dir, 'fixtures/shared-root')
async function compileOrder(entry: string) {
  const { routes, componentFile } = await scanRoutes(join(sharedRoot, entry))
  return compileApp({
    appRoot: sharedRoot,
    leaves: flattenRoutes(routes).leaves,
    componentFile,
    runtimeImport: '/_brust/client/runtime-test.js',
    serverOnly: [],
    log: () => {},
  })
}
const named = (m: Map<string, Compiled>, name: string) => [...m.values()].find((c) => c.id.startsWith(`${name}_`))!
/** The members a client chunk's behaviour returns (`return { _l1, _k1, _p1 }`). */
const members = (js: string | undefined) => /return \{ ([^}]*) \}/.exec(js ?? '')?.[1]?.split(', ') ?? []

test('F75: a route root another route links as a child keeps the linked compile, in both route orders', async () => {
  const ab = await compileOrder('routes-ab.tsx')
  const ba = await compileOrder('routes-ba.tsx')
  for (const { compiled } of [ab, ba]) {
    const [list, row, board] = [named(compiled, 'list'), named(compiled, 'row'), named(compiled, 'board')]
    // Every member Board's template drives on List's rows is in List's stored chunk.
    const driven = [
      ...new Set(
        [...board.jinja.matchAll(/x-for="\w+ in (\w+) by (\w+)"|x-props-bind="(\w+):/g)].flatMap((m) =>
          m.slice(1).filter((x): x is string => x !== undefined),
        ),
      ),
    ]
    expect(driven.sort()).toEqual(['_k1', '_l1', '_p1'])
    expect(members(list.clientJs)).toEqual(expect.arrayContaining(driven))
    expect(members(row.clientJs)).toEqual(['_c1']) // Row's x-text in Board's rows
    // /a renders the same record: List is its own host (the pre-F70 shape), not plain rows.
    expect(list.ir.tier).toBe('Native')
    expect(list.jinja).toContain(`x-data="${list.id}"`)
  }
  expect([...ba.compiled.keys()].sort()).toEqual([...ab.compiled.keys()].sort())
  for (const [id, a] of ab.compiled) {
    const b = ba.compiled.get(id)!
    expect([b.ir, b.jinja, b.clientJs, b.serverTs]).toEqual([a.ir, a.jinja, a.clientJs, a.serverTs])
  }
})

test('F75: the manifest is the same in both route orders and links List + Row chunks on /a and /b', async () => {
  const comps: unknown[] = []
  for (const entry of ['routes-ab.tsx', 'routes-ba.tsx']) {
    const out = mkdtempSync(join(tmpdir(), 'brust-f75-'))
    try {
      await runBuild({ appRoot: sharedRoot, entry, outDir: out, log: () => {} })
      const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
      const id = (name: string) => Object.keys(m.components).find((k) => k.startsWith(`${name}_`))!
      expect(m.components[id('list')].client).toMatch(/^client\/list_/)
      expect(m.components[id('row')].client).toMatch(/^client\/row_/)
      // biome-ignore lint/suspicious/noExplicitAny: manifest JSON
      expect(m.components[id('board')].children.map((c: any) => c.id).sort()).toEqual([id('list'), id('row')])
      comps.push(m.components)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }
  expect(comps[1]).toEqual(comps[0])
}, 60_000)

test('F75: replaces() keeps a child over a root and a chunk over none; disagreeing child compiles fail', () => {
  const seen = (role: Role, tree: string, o: Partial<CompiledComponent> = {}): Seen => ({
    role,
    tree,
    c: { id: 'x_1', source: 'X.tsx', ir: '{"tier":"Static"}', jinja: '<p></p>', diagnostics: [], ...o },
  })
  const linked = { jinja: '<p x-data="x_1"></p>', clientJs: 'js' }
  const native = { ir: '{"tier":"Native"}', jinja: '<p x-data="x_1"></p>', clientJs: 'js' }
  const thrown = (f: () => unknown) => {
    try {
      f()
    } catch (e) {
      return e
    }
    return 'did not throw'
  }
  // A root may differ from a child compile (F70): the child wins whichever tree came first.
  expect(replaces(seen(ROLE.root, 'X.tsx'), seen(ROLE.chunkChild, 'P.tsx', native))).toBe(true)
  expect(replaces(seen(ROLE.chunkChild, 'P.tsx', native), seen(ROLE.root, 'X.tsx'))).toBe(false)
  // Same IR, linked in one tree only: the chunk-bearing compile wins either way round.
  expect(replaces(seen(ROLE.child, 'A.tsx'), seen(ROLE.chunkChild, 'B.tsx', linked))).toBe(true)
  expect(replaces(seen(ROLE.chunkChild, 'B.tsx', linked), seen(ROLE.child, 'A.tsx'))).toBe(false)
  // Identical child compiles: the first stays.
  expect(replaces(seen(ROLE.chunkChild, 'A.tsx', linked), seen(ROLE.chunkChild, 'B.tsx', linked))).toBe(false)
  // Two child compiles with different IR, or the same role with different artifacts: divergent.
  expect(thrown(() => replaces(seen(ROLE.child, 'A.tsx'), seen(ROLE.chunkChild, 'B.tsx', native)))).toMatchObject({
    rule: 'component-compile-divergent',
    message: 'x_1 (X.tsx) compiles differently as a child in A.tsx and in B.tsx',
  })
  expect(
    thrown(() => replaces(seen(ROLE.chunkChild, 'A.tsx', linked), seen(ROLE.chunkChild, 'B.tsx', { ...linked, clientJs: 'other' }))),
  ).toMatchObject({ rule: 'component-compile-divergent' })
  expect(thrown(() => replaces(seen(ROLE.child, 'A.tsx'), seen(ROLE.child, 'B.tsx', { serverTs: 'job' })))).toMatchObject({
    rule: 'component-compile-divergent',
  })
})
