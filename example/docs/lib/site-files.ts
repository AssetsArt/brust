// Static discovery files — `sitemap.xml` (search engines) and `llms.txt`
// (language models, https://llmstxt.org) — generated at routes-module import
// time (main process only, `if (!isWorker)` at the call site in routes.tsx)
// and written into public/ so they exist in dev, in dist/public (build.ts
// imports routes.tsx BEFORE copying public), and in the SSG output. Served
// root-mapped: public/sitemap.xml → /sitemap.xml, public/llms.txt → /llms.txt.
//
// Same lifecycle + safety contract as lib/search-index.ts: any failure logs
// loudly and returns instead of throwing — a broken sitemap must never kill
// server boot. The page list is read from the markdown content dir through the
// SAME public brustjs/routes helpers the router uses (scanMdDir + mdUrlPath),
// so the emitted urls can never drift from the live routes. Grouping/sort is
// replicated locally (NOT mdNav) to stay self-contained and unit-testable on a
// tmp dir, with the prefix passed explicitly — no dependence on mdRoutes having
// registered the dir first.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mdUrlPath, scanMdDir } from 'brustjs/routes'

/** Canonical production origin, NO trailing slash. Sitemap `<loc>` entries
 *  must be absolute; llms.txt links are absolute for the same reason (an LLM
 *  may read the file detached from its host). This is the custom domain the
 *  docs are served from — NOT the underlying *.pages.dev deploy alias, so
 *  search engines index a single canonical host. Override in tests. */
export const SITE_URL = 'https://brust.assetsart.com'

/** One-line project summary for the llms.txt blockquote (llmstxt.org §format).
 *  A project tagline, deliberately NOT scraped from a page's frontmatter — a
 *  page `description` reads as "what this page covers", not "what brust is". */
const LLMS_SUMMARY =
  'A native-first React framework on Bun + Rust: pages are server-rendered HTML by default, and interactivity is added back island by island.'

interface SitePage {
  title: string
  path: string
  description: string
  group: string | null
  order: number
}

/** XML-escape a `<loc>` value (only `&` <> ' " can break the element). URLs
 *  here are ASCII, but a `&` in a future path would corrupt the document. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Join the site origin with a root-absolute path. `'/'` → `<origin>/`. */
function absUrl(siteUrl: string, p: string): string {
  return `${siteUrl}${p}`
}

export interface GenerateSiteFilesOptions {
  /** Defaults module-relative (NOT cwd): `<example/docs>/content`. */
  contentDir?: string
  /** Defaults module-relative: `<example/docs>/public`. */
  publicDir?: string
  /** URL prefix the md pages mount under. Default '/docs' (routes.tsx). */
  prefix?: string
  /** Canonical origin. Default {@link SITE_URL}. */
  siteUrl?: string
  /** Top-level routes outside the md scan (the native Home page). Each is
   *  emitted in the sitemap before the doc pages and is NOT listed in llms.txt
   *  (llms.txt indexes documentation, not the marketing landing page).
   *  Default `['/']`. */
  extraPaths?: string[]
}

export interface GeneratedSiteFiles {
  sitemap: string
  llms: string
  /** All urls (absolute) in the sitemap, in emit order — for tests/inspection. */
  urls: string[]
}

/**
 * Scan the content dir and write `sitemap.xml` + `llms.txt` into publicDir.
 * SAFE at import time: any failure logs loudly and returns `null` instead of
 * throwing — a broken discovery file must never kill server boot. Returns the
 * generated strings on success (for tests).
 */
export function generateSiteFiles(opts: GenerateSiteFilesOptions = {}): GeneratedSiteFiles | null {
  const contentDir = opts.contentDir ?? path.join(import.meta.dir, '..', 'content')
  const publicDir = opts.publicDir ?? path.join(import.meta.dir, '..', 'public')
  const prefix = opts.prefix ?? '/docs'
  const siteUrl = (opts.siteUrl ?? SITE_URL).replace(/\/+$/, '')
  const extraPaths = opts.extraPaths ?? ['/']

  try {
    const pages: SitePage[] = scanMdDir(contentDir).map((f) => {
      const nav = f.frontmatter.nav
      return {
        title:
          typeof f.frontmatter.title === 'string'
            ? f.frontmatter.title
            : (f.relPath.replace(/\.md$/, '').split('/').pop() ?? f.relPath),
        path: mdUrlPath(f.relPath, prefix),
        description: typeof f.frontmatter.description === 'string' ? f.frontmatter.description : '',
        group: typeof nav?.group === 'string' ? nav.group : null,
        order: typeof nav?.order === 'number' ? nav.order : Number.POSITIVE_INFINITY,
      }
    })
    // Sidebar order: by nav.order (missing → last) then title — identical to
    // mdNav's documented sort, so the sitemap/llms order matches the on-site
    // navigation a reader (or crawler) actually follows.
    pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))

    const sitemap = buildSitemap(siteUrl, extraPaths, pages)
    const llms = buildLlmsTxt(siteUrl, pages)

    mkdirSync(publicDir, { recursive: true })
    writeFileSync(path.join(publicDir, 'sitemap.xml'), sitemap)
    writeFileSync(path.join(publicDir, 'llms.txt'), llms)

    const urls = [
      ...extraPaths.map((p) => absUrl(siteUrl, p)),
      ...pages.map((p) => absUrl(siteUrl, p.path)),
    ]
    return { sitemap, llms, urls }
  } catch (err) {
    console.error(
      `[docs] site-files generation FAILED (continuing without sitemap/llms): ${(err as Error).stack ?? err}`,
    )
    return null
  }
}

/** `<urlset>` with one `<url><loc>` per path. extraPaths (Home) first, then the
 *  sorted doc pages. No `<lastmod>`: file mtime in a fresh checkout is the
 *  checkout time (meaningless), and a build-time stamp would churn the output
 *  every deploy — `<loc>`-only is valid and deterministic. */
function buildSitemap(siteUrl: string, extraPaths: string[], pages: SitePage[]): string {
  const locs = [...extraPaths, ...pages.map((p) => p.path)]
  const body = locs
    .map((p) => `  <url>\n    <loc>${xmlEscape(absUrl(siteUrl, p))}</loc>\n  </url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
}

/** llms.txt per https://llmstxt.org: an H1 title, a `>` blockquote summary,
 *  then one H2 per nav group (first-appearance order, matching the sorted
 *  page sequence) with a markdown link list. Each link carries the page
 *  `description` as the `: note` so a model can pick relevant pages without
 *  fetching them. Ungrouped pages (the docs index) land under "Overview". */
function buildLlmsTxt(siteUrl: string, pages: SitePage[]): string {
  const groupsInOrder: Array<string | null> = []
  const byGroup = new Map<string | null, SitePage[]>()
  for (const p of pages) {
    let bucket = byGroup.get(p.group)
    if (bucket === undefined) {
      bucket = []
      byGroup.set(p.group, bucket)
      groupsInOrder.push(p.group)
    }
    bucket.push(p)
  }

  const sections = groupsInOrder.map((group) => {
    const heading = group ?? 'Overview'
    const links = (byGroup.get(group) ?? [])
      .map((p) => {
        const note = p.description ? `: ${p.description}` : ''
        return `- [${p.title}](${absUrl(siteUrl, p.path)})${note}`
      })
      .join('\n')
    return `## ${heading}\n\n${links}`
  })

  return `# brust\n\n> ${LLMS_SUMMARY}\n\n${sections.join('\n\n')}\n`
}
