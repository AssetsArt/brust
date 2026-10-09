import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { compileApp } from '../src/build/compile'
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
  expect(item.clientJs).toContain('from "/_brust/client/runtime-test.js"')
})

test('outlet-outside-layout, unresolvable Component and lowering Error are build errors (run, not read)', async () => {
  const bad = join(import.meta.dir, 'fixtures/bad')
  await expect(buildFixture(join(bad, 'outlet-leaf'))).rejects.toMatchObject({ rule: 'outlet-outside-layout' })
  await expect(buildFixture(join(bad, 'inline-component'))).rejects.toMatchObject({ rule: 'component-source' })
  await expect(buildFixture(join(bad, 'nested-instance'))).rejects.toMatchObject({ rule: 'nested-instance' })
})
