import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { buildDevClientTag } from '../dev/client.ts'
import { emitNativeTemplates } from '../cli/native-routes-emit.ts'
import { islandChunkBasename } from '../islands/chunk-id.ts'
import { DIRECTIVES_BOOTSTRAP, ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'
import { directiveName } from '../native/build.ts'
import {
  _resetMdRoutesChangedWarnForTests,
  emitMdArtifacts,
  emitMdTemplates,
  spliceMdSlot,
  type FlatRouteLike,
} from './emit.ts'
import { MD_MANIFEST_FILENAME, mdTemplateName, type MdRouteSource } from './routes.ts'

const BAKED_BOOTSTRAP = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`

let dir: string
let outDir: string

beforeEach(() => {
  dir = join(tmpdir(), `brust-md-emit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  outDir = join(dir, 'jinja')
  mkdirSync(outDir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content: string): string {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** Lay down the standard mini fixture: routes entry, layout, island + behavior
 * components, and two content dirs (chained docs + standalone pages). */
function makeFixture() {
  const counterPath = write(
    'components/Counter.tsx',
    'export default function Counter({ start }: { start?: number }) { return <button>{start ?? 0}</button>; }\n',
  )
  const togglePath = write(
    'components/Toggle.tsx',
    'export const behavior = () => {}\nexport default function Toggle() { return <div />; }\n',
  )
  const widgetPath = write(
    'components/Widget.tsx',
    'export default function Widget({ n }: { n: number }) { return <span>{n}</span>; }\n',
  )
  const layoutPath = write(
    'DocsLayout.tsx',
    `import Widget from './components/Widget'
export default function DocsLayout({ title, w }: { title: string; w: { n: number } }) {
  return (
    <BrustPage title={title}>
      <nav>docs-nav</nav>
      <main>
        <Island component={Widget} props={w} ssr />
        <Outlet />
      </main>
    </BrustPage>
  )
}
`,
  )
  const entryFile = write(
    'routes.tsx',
    `import DocsLayout from './DocsLayout'
import Counter from './components/Counter'
import Toggle from './components/Toggle'
`,
  )
  return { counterPath, togglePath, widgetPath, layoutPath, entryFile }
}

const fakeComponent = (() => null) as any

function mdSource(
  over: Partial<MdRouteSource> & { absPath: string; relPath: string },
): MdRouteSource {
  return {
    contentDir: dirname(over.absPath),
    frontmatter: {},
    components: {},
    ...over,
  }
}

const STANDALONE_MD = `---
title: "About \\"Us\\""
description: "All about"
---

# About

Inline \`{{ code }}\` stays literal.

<Counter start={5} />

<Counter csr hydrate="idle" />

<Toggle />
`

const CHAINED_MD = `---
title: Docs Home
---

# Welcome

Docs about the marker \`island_0_props\` mechanism.

\`\`\`
data-brust-props="{{ island_0_props }}"
\`\`\`

<Counter start={1} />
`

describe('emitMdTemplates — standalone md route', () => {
  test('emits a BrustPage document with spliced md HTML, live markers, manifest, and single bake', async () => {
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    const aboutPath = write('content/pages/about.md', STANDALONE_MD)
    const tn = mdTemplateName('about.md')

    const flatRoutes: FlatRouteLike[] = [
      {
        nativeTemplate: tn,
        chain: [
          {
            Component: { name: tn },
            __mdSource: mdSource({
              absPath: aboutPath,
              relPath: 'about.md',
              contentDir,
              frontmatter: { title: 'About "Us"', description: 'All about' },
              components: { Counter: fakeComponent, Toggle: fakeComponent },
            }),
          },
        ],
      },
    ]

    const { mdIslands } = await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })

    const jinjaPath = join(outDir, `${tn}.jinja`)
    expect(existsSync(jinjaPath)).toBe(true)
    const tmpl = readFileSync(jinjaPath, 'utf8')

    // BrustPage shell with frontmatter title/description as literals.
    expect(tmpl).toContain('<title>About "Us"</title>')
    expect(tmpl).toContain('content="All about"')
    // Spliced md HTML inside the slot <main>; the slot attr survives.
    expect(tmpl).toContain(`<main data-brust-md-slot="${tn}">`)
    expect(tmpl).toContain('<h1 id="about">About</h1>')
    // md-origin braces are neutralized…
    expect(tmpl).toContain('{{ "{{" }}')
    expect(tmpl).toContain('{{ "}}" }}')
    // …while island-host jinja stays live (ssr island = instance 0).
    const counterId = islandChunkBasename('Counter', f.counterPath)
    expect(tmpl).toContain(
      `data-brust-island="${counterId}" data-brust-props="{{ island_0_props }}" data-brust-hydrate="load">{{ island_0_html | safe }}</div>`,
    )
    // csr island = instance 1, no _html slot.
    expect(tmpl).toContain(
      `data-brust-island="${counterId}" data-brust-props="{{ island_1_props }}" data-brust-hydrate="idle" data-brust-csr></div>`,
    )
    // Behavior host carries the canonical directive name.
    expect(tmpl).toContain(`x-data="${directiveName(f.togglePath, process.cwd())}"`)

    // Single bootstrap bake + directives bake.
    expect(countOccurrences(tmpl, BAKED_BOOTSTRAP)).toBe(1)
    expect(countOccurrences(tmpl, DIRECTIVES_BOOTSTRAP)).toBe(1)
    // No dev client unless asked.
    expect(tmpl).not.toContain(buildDevClientTag())

    // Manifest: md entries only (no TSX islands in the wrapper).
    const manifest = JSON.parse(readFileSync(join(outDir, `${tn}.islands.json`), 'utf8'))
    const counterRel = relative(process.cwd(), f.counterPath).replaceAll('\\', '/')
    expect(manifest).toEqual([
      {
        component: 'Counter',
        instance: 0,
        propsPath: '',
        propsLiteral: { start: 5 },
        ssr: true,
        hydrate: 'load',
        sourcePath: counterRel,
      },
      {
        component: 'Counter',
        instance: 1,
        propsPath: '',
        propsLiteral: {},
        ssr: false,
        hydrate: 'idle',
        sourcePath: counterRel,
      },
    ])

    // mdIslands return: islands only (behaviors excluded), name → abs path.
    expect(mdIslands.get('Counter')).toBe(f.counterPath)
    expect(mdIslands.has('Toggle')).toBe(false)
  })

  test('withDevClient bakes the dev client tag', async () => {
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    const aboutPath = write('content/pages/plain.md', '# Plain\n')
    const tn = mdTemplateName('plain.md')

    const flatRoutes: FlatRouteLike[] = [
      {
        nativeTemplate: tn,
        chain: [
          {
            Component: { name: tn },
            __mdSource: mdSource({ absPath: aboutPath, relPath: 'plain.md', contentDir }),
          },
        ],
      },
    ]
    await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir, withDevClient: true })
    const tmpl = readFileSync(join(outDir, `${tn}.jinja`), 'utf8')
    expect(countOccurrences(tmpl, buildDevClientTag())).toBe(1)
    // No islands anywhere in this page → no bootstrap bake.
    expect(tmpl).not.toContain(BAKED_BOOTSTRAP)
  })
})

describe('emitMdTemplates — chained md route', () => {
  test('composes the layout chain, offsets md instances past the layout TSX island, merges the manifest', async () => {
    const f = makeFixture()
    const contentDir = join(dir, 'content/docs')
    const indexPath = write('content/docs/index.md', CHAINED_MD)
    const tn = mdTemplateName('index.md')

    const flatRoutes: FlatRouteLike[] = [
      {
        nativeTemplate: tn,
        chain: [
          { Component: { name: 'DocsLayout' } },
          {
            Component: { name: tn },
            __mdSource: mdSource({
              absPath: indexPath,
              relPath: 'index.md',
              contentDir,
              frontmatter: { title: 'Docs Home' },
              components: { Counter: fakeComponent, Toggle: fakeComponent },
              layoutName: 'DocsLayout',
            }),
          },
        ],
      },
    ]

    await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })

    const tmpl = readFileSync(join(outDir, `${tn}.jinja`), 'utf8')

    // Chained wrapper shape: bare <article> slot inside the layout's single <main>.
    expect(tmpl).toContain(`<article data-brust-md-slot="${tn}">`)
    expect(tmpl).toContain('<h1 id="welcome">Welcome</h1>')
    expect(tmpl).toContain('<nav>docs-nav</nav>')
    expect(countOccurrences(tmpl, '<main')).toBe(1)
    // No nested document: exactly one <html>.
    expect(countOccurrences(tmpl, '<html')).toBe(1)

    // Layout TSX island keeps instance 0, marker id rewritten to content-addressed.
    const widgetId = islandChunkBasename('Widget', f.widgetPath)
    expect(tmpl).toContain(
      `data-brust-island="${widgetId}" data-brust-props="{{ island_0_props }}"`,
    )
    // md island is OFFSET past it → instance 1, live jinja.
    const counterId = islandChunkBasename('Counter', f.counterPath)
    expect(tmpl).toContain(
      `data-brust-island="${counterId}" data-brust-props="{{ island_1_props }}" data-brust-hydrate="load">{{ island_1_html | safe }}</div>`,
    )
    // B1 regression: marker-LOOKALIKE text in md content must NOT be renumbered
    // (renumbering is anchored on the live `{{ island_` prefix, which cannot
    // occur in neutralized content). The prose code-span and the neutralized
    // fence both keep their literal island_0_props.
    expect(tmpl).toContain('<code>island_0_props</code>')
    // Live markers: exactly one `{{ island_0_props }}` (the TSX Widget) and one
    // `{{ island_1_props }}` (the offset md Counter) — lookalikes excluded.
    expect(countOccurrences(tmpl, '{{ island_0_props }}')).toBe(1)
    expect(countOccurrences(tmpl, '{{ island_1_props }}')).toBe(1)
    // Total literal mentions: TSX live marker + prose span + neutralized fence.
    expect(countOccurrences(tmpl, 'island_0_props')).toBe(3)

    // Merged manifest: enriched TSX entry first, offset md entry appended.
    const manifest = JSON.parse(readFileSync(join(outDir, `${tn}.islands.json`), 'utf8'))
    expect(manifest).toEqual([
      {
        component: 'Widget',
        instance: 0,
        propsPath: 'w',
        ssr: true,
        hydrate: 'load',
        sourcePath: relative(process.cwd(), f.widgetPath).replaceAll('\\', '/'),
      },
      {
        component: 'Counter',
        instance: 1,
        propsPath: '',
        propsLiteral: { start: 1 },
        ssr: true,
        hydrate: 'load',
        sourcePath: relative(process.cwd(), f.counterPath).replaceAll('\\', '/'),
      },
    ])

    // Exactly one bootstrap bake even though BOTH the reconcile path and the md
    // path could have appended it.
    expect(countOccurrences(tmpl, BAKED_BOOTSTRAP)).toBe(1)
  })

  test('double emit stays idempotent — still exactly one bake of each tag', async () => {
    const f = makeFixture()
    const contentDir = join(dir, 'content/docs')
    const indexPath = write('content/docs/index.md', CHAINED_MD)
    const tn = mdTemplateName('index.md')

    const flatRoutes: FlatRouteLike[] = [
      {
        nativeTemplate: tn,
        chain: [
          { Component: { name: 'DocsLayout' } },
          {
            Component: { name: tn },
            __mdSource: mdSource({
              absPath: indexPath,
              relPath: 'index.md',
              contentDir,
              frontmatter: { title: 'Docs Home' },
              components: { Counter: fakeComponent },
              layoutName: 'DocsLayout',
            }),
          },
        ],
      },
    ]

    await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir, withDevClient: true })
    const firstRun = readFileSync(join(outDir, `${tn}.jinja`), 'utf8')
    await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir, withDevClient: true })

    const tmpl = readFileSync(join(outDir, `${tn}.jinja`), 'utf8')
    // Strongest form: the whole template is byte-identical across runs.
    expect(tmpl).toBe(firstRun)
    expect(countOccurrences(tmpl, BAKED_BOOTSTRAP)).toBe(1)
    expect(countOccurrences(tmpl, DIRECTIVES_BOOTSTRAP)).toBe(1)
    expect(countOccurrences(tmpl, buildDevClientTag())).toBe(1)

    // Manifest also stays single-merged (no duplicate md entries).
    const manifest = JSON.parse(readFileSync(join(outDir, `${tn}.islands.json`), 'utf8'))
    expect(manifest.length).toBe(2)
  })
})

describe('emitMdArtifacts — templates + manifest in one pass (task 2.8)', () => {
  test('emits the template, returns mdIslands, and writes md-manifest.json into every manifestDir', async () => {
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    const aboutPath = write('content/pages/about.md', STANDALONE_MD)
    const tn = mdTemplateName('about.md')

    const flatRoutes: FlatRouteLike[] = [
      {
        fullPath: '/about',
        nativeTemplate: tn,
        chain: [
          {
            Component: { name: tn },
            __mdSource: mdSource({
              absPath: aboutPath,
              relPath: 'about.md',
              contentDir,
              frontmatter: { title: 'About "Us"', description: 'All about' },
              components: { Counter: fakeComponent, Toggle: fakeComponent },
            }),
          },
        ],
      },
    ]

    const distDir = join(dir, 'dist')
    const brustDir = join(dir, '.brust')
    const { mdIslands } = await emitMdArtifacts({
      entryFile: f.entryFile,
      flatRoutes,
      outDir,
      manifestDirs: [distDir, brustDir],
    })

    expect(existsSync(join(outDir, `${tn}.jinja`))).toBe(true)
    expect(mdIslands.get('Counter')).toBe(f.counterPath)

    // Identical manifest in BOTH dirs, derived from the route table.
    for (const d of [distDir, brustDir]) {
      const manifest = JSON.parse(readFileSync(join(d, MD_MANIFEST_FILENAME), 'utf8'))
      expect(manifest.version).toBe(1)
      expect(manifest.contentDir).toBe(contentDir)
      expect(manifest.entries).toEqual([
        {
          relPath: 'about.md',
          templateName: tn,
          urlPath: '/about',
          frontmatter: { title: 'About "Us"', description: 'All about' },
        },
      ])
    }
  })

  test('no md routes → no template, no manifest, no dirs created (byte-identical invariant)', async () => {
    const f = makeFixture()
    const distDir = join(dir, 'dist')
    const { mdIslands } = await emitMdArtifacts({
      entryFile: f.entryFile,
      flatRoutes: [
        { fullPath: '/', nativeTemplate: 'Plain', chain: [{ Component: { name: 'Plain' } }] },
      ],
      outDir,
      manifestDirs: [distDir],
    })
    expect(mdIslands.size).toBe(0)
    expect(existsSync(join(distDir, MD_MANIFEST_FILENAME))).toBe(false)
    expect(existsSync(distDir)).toBe(false)
  })
})

describe('emitMdTemplates — dev add/remove detection (task 2.9)', () => {
  const RESTART_MSG = '[brust dev] md routes changed — restart required'

  function routesFor(contentDir: string, relPaths: string[]): FlatRouteLike[] {
    return relPaths.map((relPath) => {
      const tn = mdTemplateName(relPath)
      return {
        nativeTemplate: tn,
        chain: [
          {
            Component: { name: tn },
            __mdSource: mdSource({ absPath: join(contentDir, relPath), relPath, contentDir }),
          },
        ],
      }
    })
  }

  test('removed md file → no crash, restart warning, surviving routes still emitted', async () => {
    _resetMdRoutesChangedWarnForTests()
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    write('content/pages/a.md', '# A\n')
    write('content/pages/b.md', '# B\n')
    const flatRoutes = routesFor(contentDir, ['a.md', 'b.md'])
    rmSync(join(contentDir, 'b.md')) // route table is now stale (frozen at boot)

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })
      const restartWarnings = warnSpy.mock.calls.filter((args) => String(args[0]) === RESTART_MSG)
      expect(restartWarnings.length).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
    // a.md still emitted; b.md skipped without throwing.
    expect(existsSync(join(outDir, `${mdTemplateName('a.md')}.jinja`))).toBe(true)
    expect(existsSync(join(outDir, `${mdTemplateName('b.md')}.jinja`))).toBe(false)
  })

  test('added md file → restart warning, known routes still emitted', async () => {
    _resetMdRoutesChangedWarnForTests()
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    write('content/pages/a.md', '# A\n')
    const flatRoutes = routesFor(contentDir, ['a.md'])
    write('content/pages/new.md', '# New\n') // added after the route table froze

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })
      const restartWarnings = warnSpy.mock.calls.filter((args) => String(args[0]) === RESTART_MSG)
      expect(restartWarnings.length).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
    expect(existsSync(join(outDir, `${mdTemplateName('a.md')}.jinja`))).toBe(true)
  })

  test('warning logs ONCE per process across re-emits', async () => {
    _resetMdRoutesChangedWarnForTests()
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    write('content/pages/a.md', '# A\n')
    const flatRoutes = routesFor(contentDir, ['a.md'])
    write('content/pages/new.md', '# New\n')

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })
      await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })
      const restartWarnings = warnSpy.mock.calls.filter((args) => String(args[0]) === RESTART_MSG)
      expect(restartWarnings.length).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('matching emit set → no warning', async () => {
    _resetMdRoutesChangedWarnForTests()
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    write('content/pages/a.md', '# A\n')
    const flatRoutes = routesFor(contentDir, ['a.md'])

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })
      const restartWarnings = warnSpy.mock.calls.filter((args) => String(args[0]) === RESTART_MSG)
      expect(restartWarnings).toEqual([])
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('emitMdTemplates — errors', () => {
  test('a registry component with no routes-entry import errors naming all three identities', async () => {
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    const ghostPath = write('content/pages/ghost.md', '# G\n\n<Ghost />\n')
    const tn = mdTemplateName('ghost.md')

    const flatRoutes: FlatRouteLike[] = [
      {
        nativeTemplate: tn,
        chain: [
          {
            Component: { name: tn },
            __mdSource: mdSource({
              absPath: ghostPath,
              relPath: 'ghost.md',
              contentDir,
              components: { Ghost: fakeComponent },
            }),
          },
        ],
      },
    ]

    await expect(emitMdTemplates({ entryFile: f.entryFile, flatRoutes, outDir })).rejects.toThrow(
      /<Ghost>.*registry.*import Ghost from/s,
    )
  })
})

describe('emitNativeTemplates — md-route exclusion', () => {
  test('an md leaf is filtered out silently (no "no import" warning, no template emitted)', async () => {
    const f = makeFixture()
    const contentDir = join(dir, 'content/pages')
    const aboutPath = write('content/pages/about.md', '# About\n')
    const tn = mdTemplateName('about.md')

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await emitNativeTemplates({
        entryFile: f.entryFile,
        flatRoutes: [
          {
            nativeTemplate: tn,
            chain: [
              {
                Component: { name: tn },
                __mdSource: mdSource({ absPath: aboutPath, relPath: 'about.md', contentDir }),
              },
            ],
          },
        ],
        outDir,
        repoRoot: dir,
      })
      const noImportWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('no import for native route'),
      )
      expect(noImportWarnings).toEqual([])
    } finally {
      warnSpy.mockRestore()
    }
    expect(existsSync(join(outDir, `${tn}.jinja`))).toBe(false)
  })
})

describe('spliceMdSlot — pipeline invariants', () => {
  test('zero slots → hard error naming the template', () => {
    expect(() => spliceMdSlot('<main>nope</main>', 'Md_x_00000000', '<p>md</p>')).toThrow(
      'expected exactly one data-brust-md-slot="Md_x_00000000" element in the compiled template, found 0',
    )
  })

  test('non-empty slot → hard error', () => {
    const tmpl = '<article data-brust-md-slot="Md_x_00000000">stale</article>'
    expect(() => spliceMdSlot(tmpl, 'Md_x_00000000', '<p>md</p>')).toThrow('must compile empty')
  })

  test('invalid generated name → hard error (regex-injection guard)', () => {
    expect(() => spliceMdSlot('<main></main>', 'bad.name', '<p>md</p>')).toThrow(
      'not a valid generated name',
    )
  })
})
