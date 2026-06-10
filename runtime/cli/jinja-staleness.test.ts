import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isJinjaStale } from './jinja-staleness.ts'

let root: string
let scanRoot: string
let jinjaDir: string

beforeEach(() => {
  root = join(tmpdir(), `brust-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  scanRoot = join(root, 'app')
  jinjaDir = join(root, '.brust', 'jinja')
  mkdirSync(scanRoot, { recursive: true })
  mkdirSync(jinjaDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Stamp a file's mtime to an absolute epoch-seconds value for deterministic ordering. */
function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds)
}

describe('isJinjaStale', () => {
  test('missing _manifest.json → stale (never built)', () => {
    writeFileSync(join(scanRoot, 'Page.tsx'), 'export default () => null')
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(true)
  })

  test('manifest newer than every source .tsx → fresh', () => {
    const page = join(scanRoot, 'Page.tsx')
    writeFileSync(page, 'export default () => null')
    setMtime(page, 1000)
    const manifest = join(jinjaDir, '_manifest.json')
    writeFileSync(manifest, '{}')
    setMtime(manifest, 2000)
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(false)
  })

  test('a source .tsx newer than the manifest → stale (edited since last build)', () => {
    const manifest = join(jinjaDir, '_manifest.json')
    writeFileSync(manifest, '{}')
    setMtime(manifest, 1000)
    const page = join(scanRoot, 'Page.tsx')
    writeFileSync(page, 'export default () => null')
    setMtime(page, 2000)
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(true)
  })

  test('a NESTED component .tsx newer than the manifest → stale (transitive edit)', () => {
    const manifest = join(jinjaDir, '_manifest.json')
    writeFileSync(manifest, '{}')
    setMtime(manifest, 1000)
    const nested = join(scanRoot, 'components')
    mkdirSync(nested, { recursive: true })
    const comp = join(nested, 'Widget.tsx')
    writeFileSync(comp, 'export default () => null')
    setMtime(comp, 2000)
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(true)
  })

  test('ignores node_modules / .brust / dist when scanning for source edits', () => {
    const manifest = join(jinjaDir, '_manifest.json')
    writeFileSync(manifest, '{}')
    setMtime(manifest, 1000)
    // A "newer" .tsx buried in an ignored dir must NOT make the project look stale.
    for (const ignored of ['node_modules', '.brust', 'dist']) {
      const d = join(scanRoot, ignored)
      mkdirSync(d, { recursive: true })
      const f = join(d, 'Stale.tsx')
      writeFileSync(f, 'export default () => null')
      setMtime(f, 9999)
    }
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(false)
  })
})

// Task 2.9: .md content edits must also count as staleness. The content dirs
// come from `.brust/md-manifest.json` (next to jinjaDir); the md build marker
// is the md-manifest itself (written by emitMdArtifacts alongside the md
// templates).
describe('isJinjaStale — md content (task 2.9)', () => {
  /** Fresh-tsx baseline: a `_manifest.json` newer than every source. */
  function freshTsxBaseline(): void {
    const manifest = join(jinjaDir, '_manifest.json')
    writeFileSync(manifest, '{}')
    setMtime(manifest, 5000)
  }

  function writeMdManifest(epochSeconds: number, contentDir: string, entries: object[] = []): void {
    const file = join(root, '.brust', 'md-manifest.json')
    writeFileSync(file, JSON.stringify({ version: 1, contentDir, entries }))
    setMtime(file, epochSeconds)
  }

  test('an .md newer than md-manifest.json → stale', () => {
    freshTsxBaseline()
    const contentDir = join(root, 'content')
    mkdirSync(contentDir, { recursive: true })
    const page = join(contentDir, 'guide.md')
    writeFileSync(page, '# Guide\n')
    setMtime(page, 2000)
    writeMdManifest(1000, contentDir)
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(true)
  })

  test('all .md older than md-manifest.json → fresh', () => {
    freshTsxBaseline()
    const contentDir = join(root, 'content')
    mkdirSync(contentDir, { recursive: true })
    const page = join(contentDir, 'guide.md')
    writeFileSync(page, '# Guide\n')
    setMtime(page, 500)
    writeMdManifest(1000, contentDir)
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(false)
  })

  test('no md-manifest.json → behaves as before (fresh)', () => {
    freshTsxBaseline()
    const contentDir = join(root, 'content')
    mkdirSync(contentDir, { recursive: true })
    const page = join(contentDir, 'guide.md')
    writeFileSync(page, '# Guide\n')
    setMtime(page, 9999)
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(false)
  })

  test('unreadable md-manifest.json → behaves as before (fresh, no throw)', () => {
    freshTsxBaseline()
    const file = join(root, '.brust', 'md-manifest.json')
    writeFileSync(file, 'not json')
    setMtime(file, 1000)
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(false)
  })

  test('per-entry contentDir (multi-dir manifests) is also walked', () => {
    freshTsxBaseline()
    const primary = join(root, 'content-a')
    const secondary = join(root, 'content-b')
    mkdirSync(primary, { recursive: true })
    mkdirSync(secondary, { recursive: true })
    const stale = join(secondary, 'page.md')
    writeFileSync(stale, '# B\n')
    setMtime(stale, 2000)
    writeMdManifest(1000, primary, [
      { relPath: 'page.md', templateName: 'Md_x', urlPath: '/b/page', contentDir: secondary },
    ])
    expect(isJinjaStale(scanRoot, jinjaDir)).toBe(true)
  })
})
