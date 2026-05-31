import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'
import {
  emitNativeTemplates,
  gatherComponentSources,
  reconcileIslandManifest,
} from './native-routes-emit.ts'

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `brust-t6-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reconcileIslandManifest', () => {
  test('enriches each .islands.json entry with sourcePath from the page imports', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([
        { component: 'Counter', instance: 0, propsPath: 'data.x', ssr: false, hydrate: 'load' },
      ]),
    )

    const pageImports = new Map([['Counter', '/abs/components/Counter.tsx']])
    reconcileIslandManifest(jinjaPath, islandsJsonPath, pageImports, 'Page')

    const enriched = JSON.parse(readFileSync(islandsJsonPath, 'utf8'))
    expect(enriched).toEqual([
      {
        component: 'Counter',
        instance: 0,
        propsPath: 'data.x',
        ssr: false,
        hydrate: 'load',
        sourcePath: '/abs/components/Counter.tsx',
      },
    ])
  })

  test('appends the {% raw %}-wrapped bootstrap to the .jinja file', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    const original = '<div>hi</div>'
    writeFileSync(jinjaPath, original)
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([
        { component: 'Counter', instance: 0, propsPath: 'data.x', ssr: false, hydrate: 'load' },
      ]),
    )

    reconcileIslandManifest(
      jinjaPath,
      islandsJsonPath,
      new Map([['Counter', '/abs/Counter.tsx']]),
      'Page',
    )

    const content = readFileSync(jinjaPath, 'utf8')
    const expectedTail = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
    expect(content).toBe(original + expectedTail)
    expect(content.endsWith(expectedTail)).toBe(true)
    expect(content).toContain('{% raw %}<script type="importmap">')
    expect(content).toContain('{% endraw %}')
  })

  test('preserves the literal }} from the importmap JSON verbatim inside {% raw %}', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([
        { component: 'Counter', instance: 0, propsPath: 'data.x', ssr: false, hydrate: 'load' },
      ]),
    )

    reconcileIslandManifest(
      jinjaPath,
      islandsJsonPath,
      new Map([['Counter', '/abs/Counter.tsx']]),
      'Page',
    )

    const content = readFileSync(jinjaPath, 'utf8')
    // The importmap JSON ends with `}}` (closing imports + root object). That
    // sequence must survive verbatim in the baked .jinja.
    expect(content).toContain('}}</script>')
  })

  test('throws when a component has no matching import in the page (message contains component + route)', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([
        { component: 'Ghost', instance: 0, propsPath: 'data.x', ssr: false, hydrate: 'load' },
      ]),
    )

    // Page imports a different component — Ghost is not present.
    expect(() =>
      reconcileIslandManifest(
        jinjaPath,
        islandsJsonPath,
        new Map([['Counter', '/abs/Counter.tsx']]),
        'Page',
      ),
    ).toThrow(/Ghost.*Page|Page.*Ghost/)
  })

  test('no .islands.json → .jinja is byte-identical and no error even with empty map', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    const original = '<html><body>{{ greeting }}</body></html>'
    writeFileSync(jinjaPath, original)
    // No islands.json written.
    expect(existsSync(islandsJsonPath)).toBe(false)

    expect(() =>
      reconcileIslandManifest(jinjaPath, islandsJsonPath, new Map(), 'Page'),
    ).not.toThrow()

    expect(readFileSync(jinjaPath, 'utf8')).toBe(original)
    expect(existsSync(islandsJsonPath)).toBe(false)
  })
})

describe('emitNativeTemplates — SSR component artifacts', () => {
  test('emits .components.json and .factory.ts for a native route with an SSR component', async () => {
    // Layout.tsx — minimal SSR component (capitalized tag lowers to SsrComponent).
    const layoutPath = join(dir, 'Layout.tsx')
    writeFileSync(
      layoutPath,
      'export default function Layout({ title }: { title: string }) { return <h1>{title}</h1>; }',
    )

    // Page.tsx — uses Layout as an SSR component (no Island, so no island artifacts).
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      "import Layout from './Layout'\nexport default function Page() { return <Layout/>; }",
    )

    // routes.tsx — entry file that imports Page for the native route.
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, `import Page from './Page'\n`)

    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }],
      outDir,
      repoRoot: dir,
    })

    // .jinja must exist
    expect(existsSync(join(outDir, 'Page.jinja'))).toBe(true)

    // .components.json must exist and contain Layout with sourcePath
    const compJsonPath = join(outDir, 'Page.components.json')
    expect(existsSync(compJsonPath)).toBe(true)
    const compEntries = JSON.parse(readFileSync(compJsonPath, 'utf8')) as Array<{
      component: string
      sourcePath: string
      instance: number
      factoryExpr: string
      referencedComponents: string[]
      usesIsland: boolean
    }>
    expect(compEntries.length).toBeGreaterThan(0)
    const layoutEntry = compEntries.find((e) => e.component === 'Layout')
    expect(layoutEntry).toBeDefined()
    // sourcePath is PROJECT-RELATIVE (cwd-relative), never absolute — no build
    // machine path baked into the artifact.
    expect(isAbsolute(layoutEntry!.sourcePath)).toBe(false)
    expect(layoutEntry!.sourcePath).toBe(relative(process.cwd(), layoutPath).replaceAll('\\', '/'))
    expect(typeof layoutEntry!.factoryExpr).toBe('string')
    expect(layoutEntry!.factoryExpr.length).toBeGreaterThan(0)

    // .factory.ts must exist and contain the expected imports + export
    const factoryPath = join(outDir, 'Page.factory.ts')
    expect(existsSync(factoryPath)).toBe(true)
    const factoryContent = readFileSync(factoryPath, 'utf8')
    expect(factoryContent).toContain("import { createElement as h } from 'react'")
    // Layout import is RELATIVE to the factory dir (`../Layout.tsx`), not absolute.
    expect(factoryContent).toContain('import Layout from "../Layout.tsx"')
    expect(factoryContent).not.toMatch(/import Layout from "\//)
    expect(factoryContent).toContain('export const factories')
    // Should NOT import Island (Layout doesn't use islands)
    expect(factoryContent).not.toContain('import { Island }')

    // Bootstrap must NOT be in jinja (no usesIsland)
    const jinjaContent = readFileSync(join(outDir, 'Page.jinja'), 'utf8')
    expect(jinjaContent).not.toContain('{% raw %}')
  })

  test('injects importmap bootstrap into .jinja when SSR component uses an Island', async () => {
    // Counter.tsx — placeholder island component
    const counterPath = join(dir, 'Counter.tsx')
    writeFileSync(
      counterPath,
      'export default function Counter({ count }: { count: number }) { return <span>{count}</span>; }',
    )

    // Layout.tsx — SSR component that acts as a wrapper
    const layoutPath = join(dir, 'Layout.tsx')
    writeFileSync(
      layoutPath,
      `export default function Layout({ title }: { title: string }) { return <div><h1>{title}</h1></div>; }`,
    )

    // Page.tsx — passes an <Island> as a child of Layout (Island is inside the SsrComponent)
    // This matches NativeSsrComp.tsx's pattern: <NativeLayout title={greeting}><Island .../></NativeLayout>
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      `import Layout from './Layout'\nimport Counter from './Counter'\nexport default function Page({ greeting, counter }: { greeting: string; counter: number }) { return <Layout title={greeting}><p>hi</p><Island component={Counter} props={counter} hydrate="load" /></Layout>; }`,
    )

    // routes.tsx — entry file
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, `import Page from './Page'\n`)

    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }],
      outDir,
      repoRoot: dir,
    })

    // .jinja must contain the importmap bootstrap (usesIsland: true → injected)
    const jinjaContent = readFileSync(join(outDir, 'Page.jinja'), 'utf8')
    const expectedTail = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
    expect(jinjaContent).toContain('{% raw %}')
    expect(jinjaContent).toContain('{% endraw %}')
    expect(jinjaContent.endsWith(expectedTail)).toBe(true)

    // .factory.ts must import Island (usesIsland: true)
    const factoryContent = readFileSync(join(outDir, 'Page.factory.ts'), 'utf8')
    expect(factoryContent).toContain("import { Island } from 'brustjs'")
  })
})

describe('gatherComponentSources', () => {
  test('collects transitive native sources', () => {
    // B.tsx — leaf component
    const bPath = join(dir, 'B.tsx')
    writeFileSync(bPath, 'export default function B() { return <span>B</span>; }')

    // A.tsx — imports B
    const aPath = join(dir, 'A.tsx')
    writeFileSync(aPath, `import B from './B'\nexport default function A() { return <B/>; }`)

    // Page.tsx — imports A
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(pagePath, `import A from './A'\nexport default function Page() { return <A/>; }`)

    const { sources, mergedImports } = gatherComponentSources(pagePath)

    // Both A and B should be in sources, keyed by their ident
    expect('A' in sources).toBe(true)
    expect('B' in sources).toBe(true)
    expect(sources.A).toContain('function A')
    expect(sources.B).toContain('function B')

    // mergedImports should contain both A and B with their resolved paths
    expect(mergedImports.get('A')).toBe(aPath)
    expect(mergedImports.get('B')).toBe(bPath)
  })

  test('merges imports so a nested island reconciles (BLOCKER regression)', () => {
    // Counter.tsx — the island component, imported only by Layout
    const counterPath = join(dir, 'Counter.tsx')
    writeFileSync(
      counterPath,
      'export default function Counter({ count }: { count: number }) { return <span>{count}</span>; }',
    )

    // Layout.tsx — imports Counter (island), NOT imported directly by Page
    const layoutPath = join(dir, 'Layout.tsx')
    writeFileSync(
      layoutPath,
      `import Counter from './Counter'\nexport default function Layout() { return <div><Island component={Counter} props={0} hydrate="load"/></div>; }`,
    )

    // Page.tsx — imports Layout only (Counter is NOT directly imported here)
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      `import Layout from './Layout'\nexport default function Page() { return <Layout/>; }`,
    )

    const { mergedImports } = gatherComponentSources(pagePath)

    // Counter must be in mergedImports even though Page never imports it directly
    expect(mergedImports.get('Counter')).toBe(counterPath)
    // Layout must also be present
    expect(mergedImports.get('Layout')).toBe(layoutPath)
  })

  test('dedupes cycles — A imports B, B imports A — terminates and both present', () => {
    // Use forward declarations — write placeholder files first, then rewrite with cross-imports
    const aPath = join(dir, 'CycleA.tsx')
    const bPath = join(dir, 'CycleB.tsx')

    writeFileSync(
      aPath,
      `import CycleB from './CycleB'\nexport default function CycleA() { return <CycleB/>; }`,
    )
    writeFileSync(
      bPath,
      `import CycleA from './CycleA'\nexport default function CycleB() { return <CycleA/>; }`,
    )

    // Page imports A
    const pagePath = join(dir, 'CyclePage.tsx')
    writeFileSync(
      pagePath,
      `import CycleA from './CycleA'\nexport default function CyclePage() { return <CycleA/>; }`,
    )

    // Should not throw or infinite-loop
    let result: ReturnType<typeof gatherComponentSources> | undefined
    expect(() => {
      result = gatherComponentSources(pagePath)
    }).not.toThrow()

    // Both CycleA and CycleB should be in sources
    expect(result).toBeDefined()
    expect('CycleA' in result!.sources).toBe(true)
    expect('CycleB' in result!.sources).toBe(true)
  })

  test('ambiguous ident throws when two files import different paths as the same name', () => {
    // Create two different Card components at different paths
    const card1Path = join(dir, 'cards', 'Card.tsx')
    mkdirSync(join(dir, 'cards'), { recursive: true })
    writeFileSync(card1Path, 'export default function Card() { return <div>Card1</div>; }')

    const card2Path = join(dir, 'widgets', 'Card.tsx')
    mkdirSync(join(dir, 'widgets'), { recursive: true })
    writeFileSync(card2Path, 'export default function Card() { return <div>Card2</div>; }')

    // ComponentA imports Card from cards/
    const compAPath = join(dir, 'CompA.tsx')
    writeFileSync(
      compAPath,
      `import Card from './cards/Card'\nexport default function CompA() { return <Card/>; }`,
    )

    // ComponentB imports Card from widgets/ (different path, same ident)
    const compBPath = join(dir, 'CompB.tsx')
    writeFileSync(
      compBPath,
      `import Card from './widgets/Card'\nexport default function CompB() { return <Card/>; }`,
    )

    // Page imports both CompA and CompB — causes ambiguous Card ident
    const pagePath = join(dir, 'AmbigPage.tsx')
    writeFileSync(
      pagePath,
      `import CompA from './CompA'\nimport CompB from './CompB'\nexport default function AmbigPage() { return <div><CompA/><CompB/></div>; }`,
    )

    expect(() => gatherComponentSources(pagePath)).toThrow(/ambiguous component ident "Card"/)
  })
})
