import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ComponentType } from 'react'
import type { Route } from '../routes.ts'
import { type MdFile, scanMdDir } from './scan.ts'

/**
 * Content-addressed jinja template name for an md page:
 * `Md_<sanitized relPath>_<8hex(sha256 relPath)>`.
 *
 * Sanitizes `[^A-Za-z0-9_]` to `_`; the hash (same scheme as
 * `islandChunkBasename` in runtime/islands/chunk-id.ts) keeps two relPaths
 * that sanitize identically (e.g. `a-b.md` vs `a_b.md`) from colliding.
 */
export function mdTemplateName(relPath: string): string {
  const sanitized = relPath.replace(/[^A-Za-z0-9_]/g, '_')
  const hash = createHash('sha256').update(relPath).digest('hex').slice(0, 8)
  return `Md_${sanitized}_${hash}`
}

/**
 * Maps a content-relative md path to its URL under `prefix`.
 * `index.md` maps to the prefix itself; `guide/index.md` maps to
 * `<prefix>/guide`; `query/where.md` maps to `<prefix>/query/where`.
 * Trailing slashes on `prefix` are normalized away (`/docs/` == `/docs`).
 */
export function mdUrlPath(relPath: string, prefix: string): string {
  let base = prefix.replace(/\/+$/, '')
  if (base !== '' && !base.startsWith('/')) base = `/${base}`
  let route = relPath.replace(/\.md$/, '')
  if (route === 'index') route = ''
  else if (route.endsWith('/index')) route = route.slice(0, -'/index'.length)
  const url = route === '' ? base : `${base}/${route}`
  return url === '' ? '/' : url
}

// ── Task 2.6: mdRoutes / mdNav / frozen manifest ────────────────────────────

/** Build-time source info attached to every md leaf route. Plain field on the
 * Route node, so it survives `flattenRoutes` into `FlatRoute.chain` (the chain
 * holds the node objects); the emit step filters chains whose leaf has it. */
export interface MdRouteSource {
  absPath: string
  relPath: string
  contentDir: string
  frontmatter: MdFile['frontmatter']
  components: Record<string, ComponentType<any>>
  layoutName?: string
}

/** An md leaf route — an ordinary native Route plus the `__mdSource` marker. */
export type MdRoute = Route & { __mdSource: MdRouteSource }

export interface MdRoutesOptions {
  /** URL prefix the pages mount under. Default `'/'`. */
  prefix?: string
  /** Optional layout component — when set, mdRoutes returns ONE parent route
   * `{ path: prefix, Component: layout, children: [...mdLeaves] }`. */
  layout?: ComponentType<any>
  /** Component-tag registry for `<Name />` tags inside the md body. */
  components?: Record<string, ComponentType<any>>
}

/** One frozen-manifest entry (everything route construction needs per page). */
export interface MdManifestEntry {
  relPath: string
  templateName: string
  urlPath: string
  frontmatter: MdFile['frontmatter']
}

export interface MdManifest {
  version: 1
  contentDir: string
  entries: MdManifestEntry[]
}

export const MD_MANIFEST_FILENAME = 'md-manifest.json'

/** Write the frozen md manifest as `<dir>/md-manifest.json` (creates `dir`).
 * Returns the absolute file path written. */
export function writeMdManifest(
  dir: string,
  entries: MdManifestEntry[],
  contentDir: string,
): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, MD_MANIFEST_FILENAME)
  const manifest: MdManifest = { version: 1, contentDir, entries }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return path.resolve(file)
}

/** Read + schema-check a frozen md manifest. Throws on a missing file, bad
 * JSON, or an unsupported version (fail loudly — the manifest is build output). */
export function readMdManifest(file: string): MdManifest {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MdManifest>
  if (parsed?.version !== 1) {
    throw new Error(`md manifest ${file}: unsupported version ${String(parsed?.version)}`)
  }
  if (typeof parsed.contentDir !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error(`md manifest ${file}: malformed (expected { contentDir, entries })`)
  }
  return parsed as MdManifest
}

/** Prebuilt-dist detection: the SAME signal index.ts uses to resolve jinjaDir
 * at boot (`BRUST_PREBUILT === '1'` + `BRUST_DIST_DIR`, set by the dist bundle
 * banner — see runtime/cli/build.ts). In a prebuilt run, md routes come from
 * the frozen `<distDir>/md-manifest.json` (the content dir may not ship);
 * everywhere else we fs-scan. A manifest written for a DIFFERENT content dir
 * is ignored (falls back to scan). */
function loadPrebuiltMdManifest(contentDir: string): MdManifest | null {
  if (process.env.BRUST_PREBUILT !== '1') return null
  const distDir = process.env.BRUST_DIST_DIR
  if (!distDir) return null
  const file = path.join(distDir, MD_MANIFEST_FILENAME)
  if (!existsSync(file)) return null
  let manifest: MdManifest
  try {
    manifest = readMdManifest(file)
  } catch (err) {
    console.warn(
      `[brust] md manifest unreadable, falling back to fs scan: ${(err as Error).message}`,
    )
    return null
  }
  if (path.resolve(manifest.contentDir) !== path.resolve(contentDir)) return null
  return manifest
}

/** mdNav needs the prefix mdRoutes mounted a content dir under; record it at
 * mdRoutes() time (routes.tsx runs in the same process). Keyed by resolved
 * content dir. mdNav falls back to '/' when mdRoutes wasn't called. */
const mdNavPrefixes = new Map<string, string>()

/** Resolve the page list for a content dir: frozen manifest in a prebuilt
 * run, fs scan otherwise. */
function resolveMdPages(contentDir: string, prefix: string): MdManifestEntry[] {
  const manifest = loadPrebuiltMdManifest(contentDir)
  if (manifest) {
    // urlPath is recomputed from relPath + the caller's prefix so the routes
    // stay deterministic even if the manifest was written with another prefix.
    return manifest.entries.map((e) => ({ ...e, urlPath: mdUrlPath(e.relPath, prefix) }))
  }
  return scanMdDir(contentDir).map((f) => ({
    relPath: f.relPath,
    templateName: mdTemplateName(f.relPath),
    urlPath: mdUrlPath(f.relPath, prefix),
    frontmatter: f.frontmatter,
  }))
}

/** Turn a directory of `.md` files into native Route entries. Each file gets a
 * synthetic named component (name = its jinja template name, satisfying
 * `validateRoute`'s native checks) and a loader exposing the frontmatter as
 * `{ __md: { title, description } }`. With `layout`, returns ONE parent route
 * at `prefix` whose children carry prefix-relative paths; without, the leaves
 * carry the full prefixed path. */
export function mdRoutes(contentDir: string, opts: MdRoutesOptions = {}): Route[] {
  const prefix = opts.prefix ?? '/'
  mdNavPrefixes.set(path.resolve(contentDir), prefix)
  const components = opts.components ?? {}
  const layoutName = opts.layout?.name
  // Normalized prefix URL ('/docs' for '/docs/', '/' for '').
  const basePath = mdUrlPath('index.md', prefix)

  const leaves: MdRoute[] = resolveMdPages(contentDir, prefix).map((page) => {
    const C = () => null
    // validateRoute requires a NAMED component for native routes; the name is
    // also what flattenRoutes captures as `nativeTemplate`, so it must equal
    // the emitted jinja template name.
    Object.defineProperty(C, 'name', { value: page.templateName })
    const title = typeof page.frontmatter.title === 'string' ? page.frontmatter.title : undefined
    const description =
      typeof page.frontmatter.description === 'string' ? page.frontmatter.description : undefined
    return {
      path: opts.layout ? relativeToBase(page.urlPath, basePath) : page.urlPath,
      native: true,
      Component: C,
      // Uniform loader (chained AND standalone): head metadata only.
      loader: async () => ({ __md: { title, description } }),
      __mdSource: {
        absPath: path.resolve(contentDir, page.relPath),
        relPath: page.relPath,
        contentDir,
        frontmatter: page.frontmatter,
        components,
        layoutName,
      },
    }
  })

  if (opts.layout === undefined) return leaves
  return [{ path: basePath, native: true, Component: opts.layout, children: leaves }]
}

/** Strip the mount base off a full url path (index page → `''`, which
 * `joinPath` composes back onto the parent path unchanged). */
function relativeToBase(urlPath: string, basePath: string): string {
  if (urlPath === basePath) return ''
  return basePath === '/' ? urlPath.slice(1) : urlPath.slice(basePath.length + 1)
}

export interface MdNavItem {
  title: string
  path: string
  order?: number
}

export interface MdNavGroup {
  group: string | null
  items: MdNavItem[]
}

/** Navigation model for a content dir: items grouped by `frontmatter.nav.group`
 * (ungrouped pages land in a `group: null` top-level bucket), sorted by
 * `nav.order` (missing order sorts last) then title. Paths use the prefix the
 * dir was mounted under by `mdRoutes` (frozen-manifest urlPaths in a prebuilt
 * run; `'/'` if mdRoutes was never called for the dir). Group order follows
 * the first appearance of each group in the sorted item sequence. */
export function mdNav(contentDir: string): MdNavGroup[] {
  const manifest = loadPrebuiltMdManifest(contentDir)
  const pages: MdManifestEntry[] = manifest
    ? manifest.entries
    : scanMdDir(contentDir).map((f) => ({
        relPath: f.relPath,
        templateName: mdTemplateName(f.relPath),
        urlPath: mdUrlPath(f.relPath, mdNavPrefixes.get(path.resolve(contentDir)) ?? '/'),
        frontmatter: f.frontmatter,
      }))

  const items = pages.map((p) => {
    const nav = p.frontmatter.nav
    return {
      group: typeof nav?.group === 'string' ? nav.group : null,
      title:
        typeof p.frontmatter.title === 'string' ? p.frontmatter.title : defaultTitle(p.relPath),
      path: p.urlPath,
      order: typeof nav?.order === 'number' ? nav.order : undefined,
    }
  })
  items.sort(
    (a, b) =>
      (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
      a.title.localeCompare(b.title),
  )

  const groups = new Map<string | null, MdNavItem[]>()
  for (const item of items) {
    let bucket = groups.get(item.group)
    if (bucket === undefined) {
      bucket = []
      groups.set(item.group, bucket)
    }
    bucket.push({ title: item.title, path: item.path, order: item.order })
  }
  return [...groups].map(([group, groupItems]) => ({ group, items: groupItems }))
}

/** Title fallback for pages without a frontmatter title: the file stem. */
function defaultTitle(relPath: string): string {
  const stem = relPath.replace(/\.md$/, '')
  return stem.split('/').pop() ?? stem
}
