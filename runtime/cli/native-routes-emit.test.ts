import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { DIRECTIVES_BOOTSTRAP, ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'
import { aiScriptTag } from '../generator.ts'
import { buildDevClientTag } from '../dev/client.ts'
import {
  bakeDirectivesIfUsed,
  buildChainWrapperSource,
  countMainTags,
  emitNativeTemplates,
  extractLucideIcons,
  gatherChainSources,
  gatherComponentSources,
  injectDevClientIntoTemplate,
  reconcileIslandManifest,
  resetNativeEmitMemo,
  scanImportRefs,
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
  test('enriches each .islands.json entry with a PROJECT-RELATIVE sourcePath (no leaked absolute path)', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([
        { component: 'Counter', instance: 0, propsPath: 'data.x', ssr: false, hydrate: 'load' },
      ]),
    )

    // Use an absolute path UNDER the project root so the relative result is a
    // clean forward-slash path, not a `../../` escape — and crucially never the
    // build machine's absolute path (which would leak the developer's username
    // into shipped dist/jinja artifacts). Mirrors the .components.json contract.
    const absSource = join(process.cwd(), 'components', 'Counter.tsx')
    const pageImports = new Map([
      ['Counter', { spec: absSource, bare: false, kind: 'default' as const }],
    ])
    reconcileIslandManifest(jinjaPath, islandsJsonPath, pageImports, 'Page')

    const enriched = JSON.parse(readFileSync(islandsJsonPath, 'utf8'))
    expect(enriched).toEqual([
      {
        component: 'Counter',
        instance: 0,
        propsPath: 'data.x',
        ssr: false,
        hydrate: 'load',
        sourcePath: 'components/Counter.tsx',
      },
    ])
    expect(isAbsolute(enriched[0].sourcePath)).toBe(false)
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
      new Map([['Counter', { spec: '/abs/Counter.tsx', bare: false, kind: 'default' as const }]]),
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
      new Map([['Counter', { spec: '/abs/Counter.tsx', bare: false, kind: 'default' as const }]]),
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
        new Map([['Counter', { spec: '/abs/Counter.tsx', bare: false, kind: 'default' as const }]]),
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
      "import { useState } from 'react'\nexport default function Layout({ title }: { title: string }) { useState(0); return <h1>{title}</h1>; }",
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

  test('generator meta: BrustPage documents get it after the viewport anchor; fragments are excluded', async () => {
    // Document route — the compiler emits the full <head> with the viewport
    // anchor, so the emitter must splice the generator meta right after it.
    const docPath = join(dir, 'DocPage.tsx')
    writeFileSync(
      docPath,
      `export default function DocPage() {
  return (
    <BrustPage title="Doc">
      <main>
        <h1>doc</h1>
      </main>
    </BrustPage>
  )
}
`,
    )
    // Fragment route — no document, no anchor → spec exclusion: NO meta, no error.
    const fragPath = join(dir, 'FragPage.tsx')
    writeFileSync(
      fragPath,
      'export default function FragPage() { return <section>frag</section>; }',
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(
      routesPath,
      `import DocPage from './DocPage'\nimport FragPage from './FragPage'\n`,
    )
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'DocPage' }, { nativeTemplate: 'FragPage' }],
      outDir,
      repoRoot: dir,
    })

    const doc = readFileSync(join(outDir, 'DocPage.jinja'), 'utf8')
    expect(doc).toMatch(
      /<meta name="viewport" content="width=device-width, initial-scale=1"\/><meta name="generator" content="brust[^"]*"\/>/,
    )
    const frag = readFileSync(join(outDir, 'FragPage.jinja'), 'utf8')
    expect(frag).not.toContain('name="generator"')
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
      `import { useState } from 'react'
export default function Layout({ title }: { title: string }) { useState(0); return <div><h1>{title}</h1></div>; }`,
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
    expect(mergedImports.get('A')!.spec).toBe(aPath)
    expect(mergedImports.get('B')!.spec).toBe(bPath)
  })

  test('two named consts imported from the SAME file both get a sources entry', () => {
    // consts.ts — one shared data module with TWO exported consts
    const constsPath = join(dir, 'consts.ts')
    writeFileSync(
      constsPath,
      `export const NAV_LINKS = [{ href: '/a', label: 'A' }]\nexport const POLICY_LINKS = [{ href: '/b', label: 'B' }]\n`,
    )

    // Page.tsx — imports both idents in one declaration
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      `import { NAV_LINKS, POLICY_LINKS } from './consts'\nexport default function Page() { return <nav>{NAV_LINKS.map((l) => <a href={l.href}>{l.label}</a>)}{POLICY_LINKS.map((l) => <a href={l.href}>{l.label}</a>)}</nav>; }`,
    )

    const { sources, mergedImports } = gatherComponentSources(pagePath)

    // BOTH idents must be keyed — the Rust compiler resolves each named import
    // via componentSources[localName]; a missing key fails static evaluation.
    expect('NAV_LINKS' in sources).toBe(true)
    expect('POLICY_LINKS' in sources).toBe(true)
    expect(sources.POLICY_LINKS).toContain('POLICY_LINKS')
    expect(mergedImports.get('NAV_LINKS')!.spec).toBe(constsPath)
    expect(mergedImports.get('POLICY_LINKS')!.spec).toBe(constsPath)
  })

  test('transitive child importing two consts from one file keys both idents', () => {
    const constsPath = join(dir, 'consts.ts')
    writeFileSync(constsPath, `export const A_LINKS = ['a']\nexport const B_LINKS = ['b']\n`)

    const navPath = join(dir, 'Nav.tsx')
    writeFileSync(
      navPath,
      `import { A_LINKS, B_LINKS } from './consts'\nexport default function Nav() { return <div>{A_LINKS.map((x) => <i>{x}</i>)}{B_LINKS.map((x) => <b>{x}</b>)}</div>; }`,
    )

    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      `import Nav from './Nav'\nexport default function Page() { return <Nav/>; }`,
    )

    const { sources } = gatherComponentSources(pagePath)
    expect('A_LINKS' in sources).toBe(true)
    expect('B_LINKS' in sources).toBe(true)
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
    expect(mergedImports.get('Counter')!.spec).toBe(counterPath)
    // Layout must also be present
    expect(mergedImports.get('Layout')!.spec).toBe(layoutPath)
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

  test('lowercase ident collision (e.g. two stores named `teamStore`) does NOT throw — only Capitalized component idents are ambiguous', () => {
    // Two distinct local store files both export-default-less but imported NAMED
    // as the same lowercase ident `teamStore` (a store singleton, not a JSX
    // component). scanImportRefs now sees named imports, but a lowercase
    // collision must not trip the component-ambiguity guard.
    const storeAPath = join(dir, 'storeA.ts')
    writeFileSync(storeAPath, 'export const teamStore = { id: "a" };')
    const storeBPath = join(dir, 'storeB.ts')
    writeFileSync(storeBPath, 'export const teamStore = { id: "b" };')

    const compAPath = join(dir, 'CompA.tsx')
    writeFileSync(
      compAPath,
      `import { teamStore } from './storeA'\nexport default function CompA() { return <div>{teamStore.id}</div>; }`,
    )
    const compBPath = join(dir, 'CompB.tsx')
    writeFileSync(
      compBPath,
      `import { teamStore } from './storeB'\nexport default function CompB() { return <div>{teamStore.id}</div>; }`,
    )

    const pagePath = join(dir, 'StorePage.tsx')
    writeFileSync(
      pagePath,
      `import CompA from './CompA'\nimport CompB from './CompB'\nexport default function StorePage() { return <div><CompA/><CompB/></div>; }`,
    )

    expect(() => gatherComponentSources(pagePath)).not.toThrow()
  })
})

describe('scanImportRefs', () => {
  test('default-local: bare:false, kind:default, spec is absolute resolved path', () => {
    const localPath = join(dir, 'Widget.tsx')
    writeFileSync(localPath, 'export default function Widget() { return <div/>; }')
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import Widget from './Widget'\nexport default function Page() { return <Widget/>; }",
    )

    const refs = scanImportRefs(file)
    const w = refs.get('Widget')
    expect(w).toBeDefined()
    expect(w!.bare).toBe(false)
    expect(w!.kind).toBe('default')
    expect(w!.spec).toBe(localPath)
    expect(isAbsolute(w!.spec)).toBe(true)
    expect(w!.imported).toBeUndefined()
  })

  test('default-package: bare:true, kept verbatim (not skipped, not resolved)', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import Search from 'lucide-react/dist/esm/icons/search.mjs'\nexport default function Page() { return <Search/>; }",
    )
    const refs = scanImportRefs(file)
    const s = refs.get('Search')
    expect(s).toBeDefined()
    expect(s!.bare).toBe(true)
    expect(s!.kind).toBe('default')
    expect(s!.spec).toBe('lucide-react/dist/esm/icons/search.mjs')
  })

  test('named import: kind:named, imported === local', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import { Search } from 'lucide-react'\nexport default function Page() { return <Search/>; }",
    )
    const refs = scanImportRefs(file)
    const s = refs.get('Search')
    expect(s).toBeDefined()
    expect(s!.bare).toBe(true)
    expect(s!.kind).toBe('named')
    expect(s!.imported).toBe('Search')
    expect(s!.spec).toBe('lucide-react')
  })

  test('named import with alias: local C, imported B', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import { Search as Icon } from 'lucide-react'\nexport default function Page() { return <Icon/>; }",
    )
    const refs = scanImportRefs(file)
    expect(refs.has('Search')).toBe(false)
    const icon = refs.get('Icon')
    expect(icon).toBeDefined()
    expect(icon!.kind).toBe('named')
    expect(icon!.imported).toBe('Search')
    expect(icon!.bare).toBe(true)
    expect(icon!.spec).toBe('lucide-react')
  })

  test('named import: multiple specifiers → one entry each', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import { Search, Menu as Bars } from 'lucide-react'\nexport default function Page() { return <Search/>; }",
    )
    const refs = scanImportRefs(file)
    expect(refs.get('Search')!.imported).toBe('Search')
    expect(refs.get('Bars')!.imported).toBe('Menu')
    expect(refs.get('Search')!.kind).toBe('named')
    expect(refs.get('Bars')!.kind).toBe('named')
  })

  test('namespace import: kind:namespace, recorded parse-only', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import * as Lucide from 'lucide-react'\nexport default function Page() { return <div/>; }",
    )
    const refs = scanImportRefs(file)
    const l = refs.get('Lucide')
    expect(l).toBeDefined()
    expect(l!.kind).toBe('namespace')
    expect(l!.bare).toBe(true)
    expect(l!.spec).toBe('lucide-react')
    expect(l!.imported).toBeUndefined()
  })

  test('mixed default + named: both entries recorded', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import React, { useState } from 'react'\nexport default function Page() { return <div/>; }",
    )
    const refs = scanImportRefs(file)
    const r = refs.get('React')
    expect(r).toBeDefined()
    expect(r!.kind).toBe('default')
    expect(r!.bare).toBe(true)
    const u = refs.get('useState')
    expect(u).toBeDefined()
    expect(u!.kind).toBe('named')
    expect(u!.imported).toBe('useState')
  })

  test('local namespace + named resolve spec to absolute path (bare:false)', () => {
    const localPath = join(dir, 'lib.tsx')
    writeFileSync(
      localPath,
      'export const Foo = () => <div/>; export function Bar() { return <div/>; }',
    )
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import { Bar } from './lib'\nimport * as Lib from './lib'\nexport default function Page() { return <Bar/>; }",
    )
    const refs = scanImportRefs(file)
    expect(refs.get('Bar')!.bare).toBe(false)
    expect(refs.get('Bar')!.spec).toBe(localPath)
    expect(refs.get('Lib')!.bare).toBe(false)
    expect(refs.get('Lib')!.spec).toBe(localPath)
  })

  test('type-only imports are skipped (no phantom bindings)', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import type { Props } from 'lib'\nimport type Cfg from './cfg'\nimport { Icon } from 'lucide-react'\nexport default function Page() { return <Icon/>; }",
    )
    const refs = scanImportRefs(file)
    expect(refs.has('Props')).toBe(false)
    expect(refs.has('Cfg')).toBe(false)
    expect(refs.has('type')).toBe(false)
    expect(refs.get('Icon')!.kind).toBe('named')
  })

  test('multiline named import parses (regex [^quotes] spans newlines)', () => {
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      "import {\n  Search,\n  Menu as M,\n} from 'lucide-react'\nexport default function Page() { return <Search/>; }",
    )
    const refs = scanImportRefs(file)
    expect(refs.get('Search')!.kind).toBe('named')
    expect(refs.get('Search')!.spec).toBe('lucide-react')
    expect(refs.get('M')!.imported).toBe('Menu')
  })
})

describe('emitComponentArtifacts — import-form regeneration (via emitNativeTemplates)', () => {
  test('bare named import: factory regenerates `import { imported as Local }`, components.json keeps bare spec, Island scan skipped', async () => {
    // Page uses a named import from lucide-react; <Search/> is a simple-ident SSR component.
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      "import { Widget } from 'some-ui-lib'\nexport default function Page() { return <div><Widget/></div>; }",
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, "import Page from './Page'\n")

    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }],
      outDir,
      repoRoot: dir,
    })

    const factoryContent = readFileSync(join(outDir, 'Page.factory.ts'), 'utf8')
    expect(factoryContent).toContain('import { Widget } from "some-ui-lib"')
    // bare spec is never relativized
    expect(factoryContent).not.toMatch(/import .* from "\.\.?\//)

    const compEntries = JSON.parse(
      readFileSync(join(outDir, 'Page.components.json'), 'utf8'),
    ) as Array<{
      component: string
      sourcePath: string
    }>
    const widget = compEntries.find((e) => e.component === 'Widget')
    expect(widget).toBeDefined()
    // bare spec kept verbatim in components.json
    expect(widget!.sourcePath).toBe('some-ui-lib')
  })

  test('bare named alias: factory uses `import { imported as Local }`', async () => {
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      "import { Widget as Icon } from 'some-ui-lib'\nexport default function Page() { return <div><Icon/></div>; }",
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, "import Page from './Page'\n")
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }],
      outDir,
      repoRoot: dir,
    })

    const factoryContent = readFileSync(join(outDir, 'Page.factory.ts'), 'utf8')
    expect(factoryContent).toContain('import { Widget as Icon } from "some-ui-lib"')
  })

  test('bare default-package import: factory regenerates `import X from "<spec>"` verbatim', async () => {
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      "import Search from 'lucide-react/dist/esm/icons/search.mjs'\nexport default function Page() { return <div><Search/></div>; }",
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, "import Page from './Page'\n")
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }],
      outDir,
      repoRoot: dir,
    })

    const factoryContent = readFileSync(join(outDir, 'Page.factory.ts'), 'utf8')
    expect(factoryContent).toContain('import Search from "lucide-react/dist/esm/icons/search.mjs"')
  })

  test('backward-compat: local default import factory output byte-identical to before', async () => {
    const layoutPath = join(dir, 'Layout.tsx')
    writeFileSync(
      layoutPath,
      "import { useState } from 'react'\nexport default function Layout({ title }: { title: string }) { useState(0); return <h1>{title}</h1>; }",
    )
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      "import Layout from './Layout'\nexport default function Page() { return <Layout/>; }",
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, "import Page from './Page'\n")
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }],
      outDir,
      repoRoot: dir,
    })

    const factoryContent = readFileSync(join(outDir, 'Page.factory.ts'), 'utf8')
    // Local default import: relativized exactly as before — `import Layout from "../Layout.tsx"`
    expect(factoryContent).toContain('import Layout from "../Layout.tsx"')
    expect(factoryContent).not.toMatch(/import Layout from "\//)
  })
})

describe('reconcileIslandManifest — bare island guard', () => {
  test('throws when an island entry resolves to a bare (package) import', () => {
    const jinjaPath = join(dir, 'Page.jinja')
    const islandsJsonPath = join(dir, 'Page.islands.json')
    writeFileSync(jinjaPath, '<div>hi</div>')
    writeFileSync(
      islandsJsonPath,
      JSON.stringify([
        { component: 'Search', instance: 0, propsPath: 'data.x', ssr: false, hydrate: 'load' },
      ]),
    )
    const pageImports = new Map([
      ['Search', { spec: 'lucide-react', bare: true, kind: 'named' as const, imported: 'Search' }],
    ])
    expect(() => reconcileIslandManifest(jinjaPath, islandsJsonPath, pageImports, 'Page')).toThrow(
      /Search.*bare|bare.*Search|package/,
    )
  })
})

describe('countMainTags', () => {
  test('counts opening <main> tags (with attrs, self-closing, plain)', () => {
    expect(countMainTags('<body><main class="x">a</main></body>')).toBe(1)
    expect(countMainTags('<main>a</main><main>b</main>')).toBe(2)
    expect(countMainTags('<main/>')).toBe(1)
    expect(countMainTags('<body><div>no main</div></body>')).toBe(0)
  })
  test('does not match substrings like <maintenance>', () => {
    expect(countMainTags('<maintenance>x</maintenance>')).toBe(0)
  })
})

describe('injectDevClientIntoTemplate', () => {
  test('remains dev-only when BRUST_AI is enabled for production', () => {
    const previousAi = process.env.BRUST_AI
    process.env.BRUST_AI = '1'
    try {
      const result = injectDevClientIntoTemplate(
        '<html><head></head><body><main>page</main></body></html>',
      )
      expect(result).toContain(buildDevClientTag())
      expect(result).not.toContain(aiScriptTag())
    } finally {
      if (previousAi === undefined) delete process.env.BRUST_AI
      else process.env.BRUST_AI = previousAi
    }
  })

  test('keeps dev fragment placement byte-compatible by appending the client', () => {
    const fragment = '<main>fragment</main>'
    expect(injectDevClientIntoTemplate(fragment)).toBe(fragment + buildDevClientTag())
  })
})

describe('buildChainWrapperSource', () => {
  test('two-node chain emits a default-export wrapper with native on every tag', () => {
    const src = buildChainWrapperSource(['AppLayout', 'Leaf'])
    expect(src).toBe(
      'export default function Leaf__chain() { return <AppLayout native><Leaf native/></AppLayout>; }',
    )
  })

  test('deep chain nests parent→leaf with native on every tag', () => {
    const src = buildChainWrapperSource(['AppLayout', 'Mid', 'Leaf'])
    expect(src).toBe(
      'export default function Leaf__chain() { return <AppLayout native><Mid native><Leaf native/></Mid></AppLayout>; }',
    )
    // EVERY tag carries native (load-bearing — else children become SsrComponents).
    expect((src.match(/native/g) ?? []).length).toBe(3)
  })

  test('throws on a chain shorter than 2 (caller must use the flat path)', () => {
    expect(() => buildChainWrapperSource(['OnlyLeaf'])).toThrow(/length >= 2/)
  })
})

describe('gatherChainSources', () => {
  test('unions sources over the whole chain — keys for AppLayout AND Leaf (B1 fix)', () => {
    // AppLayout.tsx — the layout (an ancestor that the leaf no longer imports).
    const layoutPath = join(dir, 'AppLayout.tsx')
    writeFileSync(
      layoutPath,
      'export default function AppLayout({ children }: { children: any }) { return <main>{children}</main>; }',
    )
    // Leaf.tsx — a bare fragment that imports NOTHING (the new model).
    const leafPath = join(dir, 'Leaf.tsx')
    writeFileSync(leafPath, 'export default function Leaf() { return <p>leaf</p>; }')

    // The routes entry imports both by name → importMap resolves both.
    const importMap = new Map([
      ['AppLayout', layoutPath],
      ['Leaf', leafPath],
    ])

    const { sources } = gatherChainSources(['AppLayout', 'Leaf'], importMap)
    // CRITICAL: both chain components must be present, keyed by ident — without
    // the layout source, <AppLayout native> soft-falls to an SsrComponent.
    expect('AppLayout' in sources).toBe(true)
    expect('Leaf' in sources).toBe(true)
    expect(sources.AppLayout).toContain('function AppLayout')
    expect(sources.Leaf).toContain('function Leaf')
  })

  test('throws when a chain component has no import in the routes entry', () => {
    expect(() => gatherChainSources(['Ghost', 'Leaf'], new Map())).toThrow(
      /Ghost.*no matching import|no matching import.*Ghost/,
    )
  })
})

describe('emitNativeTemplates — native chain composition (T2)', () => {
  test('composes a 2-node native chain into one native template via <Outlet/>', async () => {
    // AppLayout.tsx — native layout with an <Outlet/> children slot.
    const layoutPath = join(dir, 'AppLayout.tsx')
    writeFileSync(
      layoutPath,
      'export default function AppLayout({ title }: { title: string }) { return <div><header><h1>{title}</h1></header><main><Outlet/></main></div>; }',
    )
    // Leaf.tsx — bare native fragment, imports nothing.
    const leafPath = join(dir, 'Leaf.tsx')
    writeFileSync(
      leafPath,
      'export default function Leaf({ name }: { name: string }) { return <p>hi {name}</p>; }',
    )
    // routes.tsx — entry imports BOTH chain components by name.
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, "import AppLayout from './AppLayout'\nimport Leaf from './Leaf'\n")

    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      // Full FlatRoute-shaped stub: chain parent→leaf, nativeTemplate = leaf.
      flatRoutes: [
        {
          nativeTemplate: 'Leaf',
          chain: [{ Component: { name: 'AppLayout' } }, { Component: { name: 'Leaf' } }],
        },
      ],
      outDir,
      repoRoot: dir,
    })

    // Output is under the LEAF's template name (route table unchanged).
    const jinjaPath = join(outDir, 'Leaf.jinja')
    expect(existsSync(jinjaPath)).toBe(true)
    const tmpl = readFileSync(jinjaPath, 'utf8')
    // Leaf body is inlined where <Outlet/> was, inside the layout's <main>.
    expect(tmpl).toContain('<header><h1>')
    expect(tmpl).toContain('<main><p>hi')
    // The <Outlet/> tag itself is substituted away — none survives in the output.
    expect(tmpl).not.toContain('<Outlet')
    // Fully native — no SsrComponent slot in the template, no fallback artifacts.
    expect(tmpl).not.toContain('comp_')
    expect(existsSync(join(outDir, 'Leaf.components.json'))).toBe(false)
  })
})

describe('emitNativeTemplates — SPA shell-signature meta (Task 3)', () => {
  test('bakes S: shell meta into a standalone BrustPage document head', async () => {
    const loginPath = join(dir, 'LoginPage.tsx')
    writeFileSync(
      loginPath,
      `export default function LoginPage() {
  return (
    <BrustPage title="Login">
      <main><h1>login</h1></main>
    </BrustPage>
  )
}
`,
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, `import LoginPage from './LoginPage'\n`)
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'LoginPage', shellId: 'S:LoginPage' }],
      outDir,
      repoRoot: dir,
    })

    const tmpl = readFileSync(join(outDir, 'LoginPage.jinja'), 'utf8')
    expect(tmpl).toContain('<meta name="brust-shell" content="S:LoginPage">')
  })

  test('bakes L: shell meta into the layout BrustPage head for a native chain', async () => {
    // AppLayout is a BrustPage document (owns the head + <main><Outlet/></main>).
    const layoutPath = join(dir, 'AppLayout.tsx')
    writeFileSync(
      layoutPath,
      `export default function AppLayout({ title }: { title: string }) {
  return (
    <BrustPage title={title}>
      <header><h1>{title}</h1></header>
      <main><Outlet/></main>
    </BrustPage>
  )
}
`,
    )
    const leafPath = join(dir, 'Pages.tsx')
    writeFileSync(leafPath, 'export default function Pages() { return <p>pages</p>; }')
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, "import AppLayout from './AppLayout'\nimport Pages from './Pages'\n")
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [
        {
          nativeTemplate: 'Pages',
          shellId: 'L:AppLayout',
          chain: [{ Component: { name: 'AppLayout' } }, { Component: { name: 'Pages' } }],
        },
      ],
      outDir,
      repoRoot: dir,
    })

    const tmpl = readFileSync(join(outDir, 'Pages.jinja'), 'utf8')
    // The signature lands in the LAYOUT's BrustPage head — which is the shell doc.
    expect(tmpl).toContain('<meta name="brust-shell" content="L:AppLayout">')
  })

  test('no shellId on the flat route → no brust-shell meta baked', async () => {
    const docPath = join(dir, 'DocPage.tsx')
    writeFileSync(
      docPath,
      `export default function DocPage() {
  return (
    <BrustPage title="Doc">
      <main><h1>doc</h1></main>
    </BrustPage>
  )
}
`,
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, `import DocPage from './DocPage'\n`)
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })

    await emitNativeTemplates({
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'DocPage' }],
      outDir,
      repoRoot: dir,
    })

    const tmpl = readFileSync(join(outDir, 'DocPage.jinja'), 'utf8')
    expect(tmpl).not.toContain('brust-shell')
  })
})

describe('emitNativeTemplates — incremental dev memo (R14)', () => {
  /** Two native routes: Page (inlines Child transitively) + Other (standalone). */
  function scaffold() {
    const childPath = join(dir, 'Child.tsx')
    writeFileSync(childPath, 'export default function Child() { return <span>child-v1</span>; }')
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      `import Child from './Child'\nexport default function Page() { return <div><Child native/></div>; }`,
    )
    const otherPath = join(dir, 'Other.tsx')
    writeFileSync(otherPath, 'export default function Other() { return <p>other-v1</p>; }')
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, "import Page from './Page'\nimport Other from './Other'\n")
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })
    const opts = {
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }, { nativeTemplate: 'Other' }],
      outDir,
      repoRoot: dir,
      incremental: true,
    }
    return { opts, childPath, pagePath, otherPath, outDir }
  }

  beforeEach(() => {
    resetNativeEmitMemo()
  })

  test('second emit with unchanged sources performs 0 compiles (all skipped)', async () => {
    const { opts, outDir } = scaffold()

    const first = await emitNativeTemplates(opts)
    expect(first).toEqual({ compiled: 2, skipped: 0 })

    const second = await emitNativeTemplates(opts)
    expect(second).toEqual({ compiled: 0, skipped: 2 })

    // Skipped routes still ship: outputs on disk + listed in the manifest.
    expect(existsSync(join(outDir, 'Page.jinja'))).toBe(true)
    expect(existsSync(join(outDir, 'Other.jinja'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(outDir, '_manifest.json'), 'utf8'))
    expect(manifest.templates.sort()).toEqual(['Other', 'Page'])
  })

  test('default path (no incremental flag) compiles everything on every emit', async () => {
    const { opts } = scaffold()
    const { incremental: _drop, ...plainOpts } = opts

    expect(await emitNativeTemplates(plainOpts)).toEqual({ compiled: 2, skipped: 0 })
    expect(await emitNativeTemplates(plainOpts)).toEqual({ compiled: 2, skipped: 0 })
  })

  test('editing the route source recompiles ONLY that route', async () => {
    const { opts, otherPath, outDir } = scaffold()
    await emitNativeTemplates(opts)

    writeFileSync(otherPath, 'export default function Other() { return <p>other-v2</p>; }')
    const stats = await emitNativeTemplates(opts)
    expect(stats).toEqual({ compiled: 1, skipped: 1 })
    expect(readFileSync(join(outDir, 'Other.jinja'), 'utf8')).toContain('other-v2')
  })

  test('editing a TRANSITIVELY imported component recompiles the importing route', async () => {
    const { opts, childPath, outDir } = scaffold()
    await emitNativeTemplates(opts)
    expect(readFileSync(join(outDir, 'Page.jinja'), 'utf8')).toContain('child-v1')

    writeFileSync(childPath, 'export default function Child() { return <span>child-v2</span>; }')
    const stats = await emitNativeTemplates(opts)
    // Page (imports Child) recompiles; Other is untouched and skips.
    expect(stats).toEqual({ compiled: 1, skipped: 1 })
    expect(readFileSync(join(outDir, 'Page.jinja'), 'utf8')).toContain('child-v2')
  })

  test('hash/scan failure falls back to compiling everything (correctness over speed)', async () => {
    const { opts } = scaffold()
    const failingOpts = {
      ...opts,
      hashInputsForTest: () => {
        throw new Error('synthetic hash failure')
      },
    }

    // Never throws out of the emit; never skips.
    expect(await emitNativeTemplates(failingOpts)).toEqual({ compiled: 2, skipped: 0 })
    expect(await emitNativeTemplates(failingOpts)).toEqual({ compiled: 2, skipped: 0 })
  })

  test('a deleted output forces a recompile even on a memo hit', async () => {
    const { opts, outDir } = scaffold()
    await emitNativeTemplates(opts)

    rmSync(join(outDir, 'Page.jinja'))
    const stats = await emitNativeTemplates(opts)
    expect(stats).toEqual({ compiled: 1, skipped: 1 })
    expect(existsSync(join(outDir, 'Page.jinja'))).toBe(true)
  })

  test('generated behavior modules are memo outputs and build-only source is stripped', async () => {
    const behaviorPath = join(dir, 'Behavior.tsx')
    writeFileSync(
      behaviorPath,
      `import { useState } from 'react'
export const behavior = () => ({ activate() {} })
export default function Behavior() { useState(0); return <button x-on-click="activate">go</button> }`,
    )
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      `import Behavior from './Behavior'
export default function Page() { return <Behavior native/> }`,
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, `import Page from './Page'\n`)
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })
    const opts = {
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }],
      outDir,
      repoRoot: dir,
      incremental: true,
    }

    expect(await emitNativeTemplates(opts)).toEqual({ compiled: 1, skipped: 0 })
    const generatedName = readdirSync(outDir).find(
      (name) => name.startsWith('__brust_behavior_') && name.endsWith('.tsx'),
    )
    expect(generatedName).toBeDefined()
    const manifest = readFileSync(join(outDir, 'Page.components.json'), 'utf8')
    expect(manifest).not.toContain('behaviorModules')
    expect(manifest).not.toContain('export const behavior')

    rmSync(join(outDir, generatedName!))
    expect(await emitNativeTemplates(opts)).toEqual({ compiled: 1, skipped: 0 })
    expect(existsSync(join(outDir, generatedName!))).toBe(true)
  })

  test('dropping SSR components removes only that route’s sidecars and generated modules', async () => {
    const behaviorPath = join(dir, 'Behavior.tsx')
    writeFileSync(
      behaviorPath,
      `import { useState } from 'react'
export const behavior = () => ({ activate() {} })
export default function Behavior() { useState(0); return <button x-on-click="activate">go</button> }`,
    )
    const pagePath = join(dir, 'Page.tsx')
    const otherPath = join(dir, 'Other.tsx')
    writeFileSync(
      pagePath,
      `import Behavior from './Behavior'
export default function Page() { return <Behavior native/> }`,
    )
    writeFileSync(
      otherPath,
      `import Behavior from './Behavior'
export default function Other() { return <Behavior native/> }`,
    )
    const routesPath = join(dir, 'routes.tsx')
    writeFileSync(routesPath, `import Page from './Page'\nimport Other from './Other'\n`)
    const outDir = join(dir, 'jinja')
    mkdirSync(outDir, { recursive: true })
    const opts = {
      entryFile: routesPath,
      flatRoutes: [{ nativeTemplate: 'Page' }, { nativeTemplate: 'Other' }],
      outDir,
      repoRoot: dir,
      incremental: true,
    }

    expect(await emitNativeTemplates(opts)).toEqual({ compiled: 2, skipped: 0 })
    const pageFactory = readFileSync(join(outDir, 'Page.factory.ts'), 'utf8')
    const otherFactory = readFileSync(join(outDir, 'Other.factory.ts'), 'utf8')
    const pageGenerated = /\.\/(__brust_behavior_[^"']+\.tsx)/.exec(pageFactory)?.[1]
    const otherGenerated = /\.\/(__brust_behavior_[^"']+\.tsx)/.exec(otherFactory)?.[1]
    expect(pageGenerated).toBeDefined()
    expect(otherGenerated).toBeDefined()
    expect(pageGenerated).not.toBe(otherGenerated)

    writeFileSync(pagePath, `export default function Page() { return <main>static</main> }`)
    expect(await emitNativeTemplates(opts)).toEqual({ compiled: 1, skipped: 1 })
    expect(existsSync(join(outDir, 'Page.components.json'))).toBe(false)
    expect(existsSync(join(outDir, 'Page.factory.ts'))).toBe(false)
    expect(existsSync(join(outDir, pageGenerated!))).toBe(false)
    expect(existsSync(join(outDir, 'Other.components.json'))).toBe(true)
    expect(existsSync(join(outDir, 'Other.factory.ts'))).toBe(true)
    expect(existsSync(join(outDir, otherGenerated!))).toBe(true)
  })
})

describe('bakeDirectivesIfUsed', () => {
  test('bakes the directives bootstrap into a template that uses x-data', () => {
    const tmpl = '<html><head></head><body><div x-data="probe"></div></body></html>'
    expect(bakeDirectivesIfUsed(tmpl)).toContain(DIRECTIVES_BOOTSTRAP)
    expect(bakeDirectivesIfUsed(tmpl)).toContain('{% raw %}')
  })

  test('leaves a template without x-data byte-identical', () => {
    const tmpl = '<html><head></head><body><div>static</div></body></html>'
    expect(bakeDirectivesIfUsed(tmpl)).toBe(tmpl)
  })
})

describe('extractLucideIcons', () => {
  test('numeric icon names extract and emit as static SVG without SSR artifacts', async () => {
    const iconsPath = join(dir, 'Icons.tsx')
    writeFileSync(
      iconsPath,
      `import { FileCheck2, Repeat2, Printer } from 'lucide-react'
export default function Icons() {
  return <div><FileCheck2/><Repeat2/><Printer/></div>
}
`,
    )

    const extracted = await extractLucideIcons(iconsPath)
    expect(Object.keys(extracted).sort()).toEqual(['FileCheck2', 'Printer', 'Repeat2'])
    expect(JSON.parse(extracted.FileCheck2!).cls).toBe('lucide lucide-file-check-corner')
    expect(JSON.parse(extracted.Repeat2!).cls).toBe('lucide lucide-repeat-2')
    expect(JSON.parse(extracted.Printer!).cls).toBe('lucide lucide-printer')

    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(
      pagePath,
      `import Icons from './Icons'
export default function Page() { return <Icons/> }
`,
    )
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

    const template = readFileSync(join(outDir, 'Page.jinja'), 'utf8')
    expect(template).toContain('class="lucide lucide-file-check-corner"')
    expect(template).toContain('class="lucide lucide-repeat-2"')
    expect(template).toContain('class="lucide lucide-printer"')
    expect(template).not.toContain('comp_')
    expect(existsSync(join(outDir, 'Page.components.json'))).toBe(false)
  })

  test('AC9: extracts static icon node for a named lucide import, stripping `key`', async () => {
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(pagePath, `import { Search } from 'lucide-react'\n`)

    const map = await extractLucideIcons(pagePath)

    expect('Search' in map).toBe(true)
    const parsed = JSON.parse(map.Search!)
    expect(parsed.cls).toBe('lucide lucide-search')
    expect(Array.isArray(parsed.node)).toBe(true)
    expect(parsed.node.length).toBeGreaterThan(0)
    // node = [[tag, [[attr,val],…]], …] — no nested attr pair may carry `key`.
    for (const [, pairs] of parsed.node as Array<[string, [string, string][]]>) {
      for (const [k] of pairs) {
        expect(k).not.toBe('key')
      }
    }
  })

  test('AC10: PascalCase icon name → kebab-case cls', async () => {
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(pagePath, `import { ChevronRight } from 'lucide-react'\n`)

    const map = await extractLucideIcons(pagePath)

    expect('ChevronRight' in map).toBe(true)
    const parsed = JSON.parse(map.ChevronRight!)
    expect(parsed.cls).toBe('lucide lucide-chevron-right')
  })

  test('AC11: aliased import keys by local name, node sourced from the imported icon', async () => {
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(pagePath, `import { Search as Icon } from 'lucide-react'\n`)

    const map = await extractLucideIcons(pagePath)

    expect('Icon' in map).toBe(true)
    expect('Search' in map).toBe(false)
    const parsed = JSON.parse(map.Icon!)
    expect(parsed.cls).toBe('lucide lucide-search')
  })

  test('AC12: an unresolvable icon name is omitted (no throw)', async () => {
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(pagePath, `import { NotARealIconXYZ123 } from 'lucide-react'\n`)

    const map = await extractLucideIcons(pagePath)

    expect('NotARealIconXYZ123' in map).toBe(false)
  })

  test('AC-alias: alias icon (ArrowDownAZ) follows the re-export stub to the canonical __iconNode', async () => {
    // `ArrowDownAZ` → toKebabCase → `arrow-down-az.mjs`, which is a re-export stub
    // (`export { default } from './arrow-down-a-z.mjs'`) with NO __iconNode. The
    // extractor must follow the alias to the canonical `arrow-down-a-z.mjs`.
    const pagePath = join(dir, 'Page.tsx')
    writeFileSync(pagePath, `import { ArrowDownAZ } from 'lucide-react'\n`)

    const map = await extractLucideIcons(pagePath)

    expect('ArrowDownAZ' in map).toBe(true)
    const parsed = JSON.parse(map.ArrowDownAZ!)
    // cls uses the canonical kebab (where the data actually lives).
    expect(parsed.cls).toBe('lucide lucide-arrow-down-a-z')
    expect(Array.isArray(parsed.node)).toBe(true)
    expect(parsed.node.length).toBe(5)
  })
})
