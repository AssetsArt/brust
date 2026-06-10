import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineRoutes } from '../routes'
import { scanMdDir } from './scan'
import {
  type MdManifestEntry,
  type MdRoute,
  mdNav,
  mdRoutes,
  mdTemplateName,
  mdUrlPath,
  readMdManifest,
  writeMdManifest,
} from './routes'

describe('mdTemplateName', () => {
  test('shape: Md_<sanitized>_<8hex>', () => {
    const name = mdTemplateName('query/where.md')
    expect(name).toMatch(/^Md_query_where_md_[0-9a-f]{8}$/)
  })

  test('deterministic for the same relPath', () => {
    expect(mdTemplateName('query/where.md')).toBe(mdTemplateName('query/where.md'))
  })

  test('sanitize-collisions differ by hash (a-b.md vs a_b.md)', () => {
    const a = mdTemplateName('a-b.md')
    const b = mdTemplateName('a_b.md')
    // identical sanitized stem...
    expect(a.slice(0, -8)).toBe(b.slice(0, -8))
    // ...but distinct hashes
    expect(a).not.toBe(b)
  })
})

describe('mdUrlPath', () => {
  test('index.md at root maps to the prefix itself', () => {
    expect(mdUrlPath('index.md', '/docs')).toBe('/docs')
  })

  test('nested file maps under prefix without extension', () => {
    expect(mdUrlPath('query/where.md', '/docs')).toBe('/docs/query/where')
  })

  test('nested index maps to its directory', () => {
    expect(mdUrlPath('guide/index.md', '/docs')).toBe('/docs/guide')
  })

  test('prefix normalization: trailing slash equals no trailing slash', () => {
    expect(mdUrlPath('query/where.md', '/docs/')).toBe(mdUrlPath('query/where.md', '/docs'))
    expect(mdUrlPath('index.md', '/docs/')).toBe('/docs')
  })

  test('root prefix', () => {
    expect(mdUrlPath('index.md', '/')).toBe('/')
    expect(mdUrlPath('intro.md', '/')).toBe('/intro')
  })
})

// ── Task 2.6: mdRoutes / mdNav / frozen manifest ────────────────────────────

function makeContentDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'brust-md-routes-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

const DOCS_FILES: Record<string, string> = {
  'index.md':
    '---\ntitle: Docs Home\ndescription: "Landing page"\nnav: { order: 0 }\n---\n# Home\n',
  'intro.md':
    '---\ntitle: Introduction\nnav: { group: "Getting Started", order: 1 }\n---\n# Intro\n',
  'query/select.md': '---\ntitle: Select\nnav: { group: "Query", order: 1 }\n---\n# Select\n',
  'query/where.md': '---\ntitle: Where\nnav: { group: "Query", order: 2 }\n---\n# Where\n',
  'alpha.md': '---\ntitle: Alpha\n---\n# Alpha\n',
  'notes.md': '# Notes (no frontmatter)\n',
}

/** Save/restore the prebuilt env signals around a callback. */
function withPrebuiltEnv<T>(distDir: string | null, fn: () => T): T {
  const savedPrebuilt = process.env.BRUST_PREBUILT
  const savedDist = process.env.BRUST_DIST_DIR
  if (distDir === null) {
    delete process.env.BRUST_PREBUILT
    delete process.env.BRUST_DIST_DIR
  } else {
    process.env.BRUST_PREBUILT = '1'
    process.env.BRUST_DIST_DIR = distDir
  }
  try {
    return fn()
  } finally {
    if (savedPrebuilt === undefined) delete process.env.BRUST_PREBUILT
    else process.env.BRUST_PREBUILT = savedPrebuilt
    if (savedDist === undefined) delete process.env.BRUST_DIST_DIR
    else process.env.BRUST_DIST_DIR = savedDist
  }
}

function DocsLayout() {
  return null
}

describe('mdRoutes', () => {
  test('without layout: one native leaf per file carrying the full prefixed path', () => {
    const dir = makeContentDir(DOCS_FILES)
    const routes = mdRoutes(dir, { prefix: '/docs' }) as MdRoute[]
    expect(routes).toHaveLength(6)
    const byPath = new Map(routes.map((r) => [r.path, r]))
    expect([...byPath.keys()].sort()).toEqual([
      '/docs',
      '/docs/alpha',
      '/docs/intro',
      '/docs/notes',
      '/docs/query/select',
      '/docs/query/where',
    ])
    const intro = byPath.get('/docs/intro')!
    expect(intro.native).toBe(true)
    expect(intro.Component?.name).toBe(mdTemplateName('intro.md'))
    expect(typeof intro.loader).toBe('function')
    expect(intro.children).toBeUndefined()
    // __mdSource carries everything the emit step needs.
    expect(intro.__mdSource.relPath).toBe('intro.md')
    expect(intro.__mdSource.contentDir).toBe(dir)
    expect(intro.__mdSource.absPath).toBe(join(dir, 'intro.md'))
    expect(intro.__mdSource.frontmatter.title).toBe('Introduction')
    expect(intro.__mdSource.layoutName).toBeUndefined()
    expect(intro.__mdSource.components).toEqual({})
  })

  test('without layout: defineRoutes flattens to the prefixed fullPaths', () => {
    const dir = makeContentDir(DOCS_FILES)
    const flat = defineRoutes(mdRoutes(dir, { prefix: '/docs' }))
    expect(flat.map((f) => f.fullPath).sort()).toEqual([
      '/docs',
      '/docs/alpha',
      '/docs/intro',
      '/docs/notes',
      '/docs/query/select',
      '/docs/query/where',
    ])
    for (const f of flat) {
      expect(f.nativeTemplate).toMatch(/^Md_/)
    }
  })

  test('with layout: ONE parent route at the prefix with md leaves as children', () => {
    const dir = makeContentDir(DOCS_FILES)
    const components = { Counter: DocsLayout }
    const routes = mdRoutes(dir, { prefix: '/docs', layout: DocsLayout, components })
    expect(routes).toHaveLength(1)
    const parent = routes[0]!
    expect(parent.path).toBe('/docs')
    expect(parent.Component).toBe(DocsLayout)
    expect(parent.native).toBe(true)
    expect(parent.children).toHaveLength(6)
    // Leaves carry prefix-relative paths (index.md → '').
    const childPaths = (parent.children as MdRoute[]).map((c) => c.path).sort()
    expect(childPaths).toEqual(['', 'alpha', 'intro', 'notes', 'query/select', 'query/where'])
    const where = (parent.children as MdRoute[]).find((c) => c.path === 'query/where')!
    expect(where.__mdSource.layoutName).toBe('DocsLayout')
    expect(where.__mdSource.components).toBe(components)
  })

  test('with layout: defineRoutes composes the same fullPaths and __mdSource survives into the chain', () => {
    const dir = makeContentDir(DOCS_FILES)
    const flat = defineRoutes(mdRoutes(dir, { prefix: '/docs', layout: DocsLayout }))
    expect(flat.map((f) => f.fullPath).sort()).toEqual([
      '/docs',
      '/docs/alpha',
      '/docs/intro',
      '/docs/notes',
      '/docs/query/select',
      '/docs/query/where',
    ])
    const intro = flat.find((f) => f.fullPath === '/docs/intro')!
    expect(intro.chain).toHaveLength(2)
    expect(intro.chain[0]!.Component).toBe(DocsLayout)
    const leaf = intro.chain[intro.chain.length - 1] as MdRoute
    expect(leaf.__mdSource.relPath).toBe('intro.md')
    expect(leaf.__mdSource.frontmatter.nav).toEqual({ group: 'Getting Started', order: 1 })
  })

  test('root prefix default: leaves map under /', () => {
    const dir = makeContentDir({ 'index.md': '# Home\n', 'intro.md': '# Intro\n' })
    const routes = mdRoutes(dir)
    expect(routes.map((r) => r.path).sort()).toEqual(['/', '/intro'])
  })

  test('generated loader returns { __md: { title, description } } from frontmatter', async () => {
    const dir = makeContentDir(DOCS_FILES)
    const routes = mdRoutes(dir, { prefix: '/docs' }) as MdRoute[]
    const index = routes.find((r) => r.path === '/docs')!
    const introLoader = routes.find((r) => r.path === '/docs/intro')!.loader!
    const notesLoader = routes.find((r) => r.path === '/docs/notes')!.loader!
    expect(await index.loader!({} as never)).toEqual({
      __md: { title: 'Docs Home', description: 'Landing page' },
    })
    expect(await introLoader({} as never)).toEqual({
      __md: { title: 'Introduction', description: undefined },
    })
    expect(await notesLoader({} as never)).toEqual({
      __md: { title: undefined, description: undefined },
    })
  })
})

describe('md manifest', () => {
  function entriesFromScan(contentDir: string, prefix: string): MdManifestEntry[] {
    return scanMdDir(contentDir).map((f) => ({
      relPath: f.relPath,
      templateName: mdTemplateName(f.relPath),
      urlPath: mdUrlPath(f.relPath, prefix),
      frontmatter: f.frontmatter,
    }))
  }

  test('write/read round-trip preserves the manifest shape', () => {
    const contentDir = makeContentDir(DOCS_FILES)
    const outDir = join(mkdtempSync(join(tmpdir(), 'brust-md-dist-')), 'dist')
    const entries = entriesFromScan(contentDir, '/docs')
    const file = writeMdManifest(outDir, entries, contentDir)
    const manifest = readMdManifest(file)
    expect(manifest.version).toBe(1)
    expect(manifest.contentDir).toBe(contentDir)
    expect(manifest.entries).toEqual(entries)
  })

  test('readMdManifest rejects an unknown version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brust-md-badver-'))
    const file = join(dir, 'md-manifest.json')
    writeFileSync(file, JSON.stringify({ version: 2, contentDir: 'x', entries: [] }))
    expect(() => readMdManifest(file)).toThrow(/version/)
  })

  test('prebuilt mode: mdRoutes resolves from the frozen manifest, content dir gone → identical routes', async () => {
    const contentDir = makeContentDir(DOCS_FILES)
    const distDir = mkdtempSync(join(tmpdir(), 'brust-md-dist-'))
    writeMdManifest(distDir, entriesFromScan(contentDir, '/docs'), contentDir)

    // Baseline: fs-scan routes while the content dir exists.
    const scanned = defineRoutes(mdRoutes(contentDir, { prefix: '/docs', layout: DocsLayout }))

    // Delete the content dir — prebuilt boot must not need it.
    rmSync(contentDir, { recursive: true, force: true })
    const frozen = withPrebuiltEnv(distDir, () =>
      defineRoutes(mdRoutes(contentDir, { prefix: '/docs', layout: DocsLayout })),
    )

    expect(frozen.map((f) => f.fullPath)).toEqual(scanned.map((f) => f.fullPath))
    expect(frozen.map((f) => f.nativeTemplate)).toEqual(scanned.map((f) => f.nativeTemplate))
    for (let i = 0; i < frozen.length; i++) {
      const fLeaf = frozen[i]!.chain[frozen[i]!.chain.length - 1] as MdRoute
      const sLeaf = scanned[i]!.chain[scanned[i]!.chain.length - 1] as MdRoute
      expect(fLeaf.__mdSource.relPath).toBe(sLeaf.__mdSource.relPath)
      expect(fLeaf.__mdSource.frontmatter).toEqual(sLeaf.__mdSource.frontmatter)
      expect(await fLeaf.loader!({} as never)).toEqual(await sLeaf.loader!({} as never))
    }
  })

  test('prebuilt mode: manifest for a DIFFERENT content dir is ignored (falls back to scan)', () => {
    const contentDir = makeContentDir({ 'index.md': '---\ntitle: A\n---\n# A\n' })
    const otherDir = makeContentDir({ 'index.md': '---\ntitle: B\n---\n# B\n' })
    const distDir = mkdtempSync(join(tmpdir(), 'brust-md-dist-'))
    writeMdManifest(
      distDir,
      [
        {
          relPath: 'index.md',
          templateName: mdTemplateName('index.md'),
          urlPath: '/other',
          frontmatter: { title: 'B' },
        },
      ],
      otherDir,
    )
    const routes = withPrebuiltEnv(distDir, () => mdRoutes(contentDir)) as MdRoute[]
    // Scanned from contentDir, NOT the manifest (which described otherDir).
    expect(routes[0]!.__mdSource.frontmatter.title).toBe('A')
  })

  test('non-prebuilt mode ignores any manifest and scans the fs', () => {
    const contentDir = makeContentDir({ 'index.md': '---\ntitle: Live\n---\n# Live\n' })
    const routes = withPrebuiltEnv(null, () => mdRoutes(contentDir)) as MdRoute[]
    expect(routes[0]!.__mdSource.frontmatter.title).toBe('Live')
  })
})

describe('mdNav', () => {
  test('groups by frontmatter.nav.group, sorts by order then title, ungrouped → group null', () => {
    const dir = makeContentDir(DOCS_FILES)
    mdRoutes(dir, { prefix: '/docs' }) // registers the prefix for mdNav
    const nav = mdNav(dir)
    expect(nav).toEqual([
      {
        group: null,
        items: [
          { title: 'Docs Home', path: '/docs', order: 0 },
          { title: 'Alpha', path: '/docs/alpha', order: undefined },
          { title: 'notes', path: '/docs/notes', order: undefined },
        ],
      },
      {
        group: 'Getting Started',
        items: [{ title: 'Introduction', path: '/docs/intro', order: 1 }],
      },
      {
        group: 'Query',
        items: [
          { title: 'Select', path: '/docs/query/select', order: 1 },
          { title: 'Where', path: '/docs/query/where', order: 2 },
        ],
      },
    ])
  })

  test('defaults to prefix "/" when mdRoutes was not called for the dir', () => {
    const dir = makeContentDir({ 'intro.md': '---\ntitle: Intro\n---\n# I\n' })
    const nav = mdNav(dir)
    expect(nav[0]!.items[0]!.path).toBe('/intro')
  })

  test('prebuilt mode: nav comes from the frozen manifest (content dir gone)', () => {
    const contentDir = makeContentDir(DOCS_FILES)
    const distDir = mkdtempSync(join(tmpdir(), 'brust-md-dist-'))
    const entries = scanMdDir(contentDir).map((f) => ({
      relPath: f.relPath,
      templateName: mdTemplateName(f.relPath),
      urlPath: mdUrlPath(f.relPath, '/docs'),
      frontmatter: f.frontmatter,
    }))
    writeMdManifest(distDir, entries, contentDir)
    rmSync(contentDir, { recursive: true, force: true })
    // Real boot order: routes.tsx mounts the dir (registering its prefix)
    // before any layout calls mdNav. Nav paths are recomputed against the
    // LIVE prefix, not the manifest's baked urlPaths.
    const nav = withPrebuiltEnv(distDir, () => {
      mdRoutes(contentDir, { prefix: '/docs' })
      return mdNav(contentDir)
    })
    expect(nav.map((g) => g.group)).toEqual([null, 'Getting Started', 'Query'])
    expect(nav[2]!.items.map((i) => i.path)).toEqual(['/docs/query/select', '/docs/query/where'])
  })

  test('prebuilt mode: nav follows the LIVE mdRoutes prefix over the baked manifest urlPath', () => {
    const contentDir = makeContentDir({ 'intro.md': '---\ntitle: Intro\n---\n# I\n' })
    const distDir = mkdtempSync(join(tmpdir(), 'brust-md-dist-'))
    const entries = scanMdDir(contentDir).map((f) => ({
      relPath: f.relPath,
      templateName: mdTemplateName(f.relPath),
      urlPath: mdUrlPath(f.relPath, '/old-prefix'),
      frontmatter: f.frontmatter,
    }))
    writeMdManifest(distDir, entries, contentDir)
    rmSync(contentDir, { recursive: true, force: true })
    const nav = withPrebuiltEnv(distDir, () => {
      mdRoutes(contentDir, { prefix: '/new' })
      return mdNav(contentDir)
    })
    expect(nav[0]!.items[0]!.path).toBe('/new/intro')
  })

  test('readMdManifest: malformed JSON → error names the file', () => {
    const distDir = mkdtempSync(join(tmpdir(), 'brust-md-dist-'))
    const file = join(distDir, 'md-manifest.json')
    writeFileSync(file, 'not json')
    expect(() => readMdManifest(file)).toThrow(/md-manifest\.json: invalid JSON/)
  })

  test('mdRoutes: anonymous layout component → clear error', () => {
    const dir = makeContentDir({ 'intro.md': '# I\n' })
    // Property shorthand AND const assignment both infer a name; an inline
    // array-literal member is the truly anonymous form (name === '').
    expect(() => mdRoutes(dir, { layout: [() => null][0] as never })).toThrow(/NAMED component/)
  })
})
