// The site's one production origin (human, 2026-10-13: the v2 docs live at https://brust.dev; the 0.1.x docs stay
// where they are). Every absolute URL the site emits — canonical and og:url tags, sitemap.xml, llms.txt — comes
// from this constant, so a domain change is one line.
import { href, NAV, PAGES } from './nav'

export const SITE_URL = 'https://brust.dev'

/** Every page route the static build writes, in nav order: `/`, `/docs`, then each docs page. */
export function siteRoutes(): string[] {
  return ['/', '/docs', ...PAGES.map((p) => href(p.slug))]
}

/** An absolute URL for a site path. */
export const absolute = (path: string): string => `${SITE_URL}${path === '/' ? '/' : path.replace(/\/+$/, '')}`

/** sitemap.xml: one `<url>` per route, no lastmod (the files are regenerated on every build). */
export function sitemapXml(): string {
  const urls = siteRoutes()
    .map((r) => `  <url><loc>${absolute(r)}</loc></url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/** llms.txt (llmstxt.org): a short description and the docs pages grouped as the sidebar groups them. */
export function llmsTxt(): string {
  const lines = ['# brust', '', '> React you write, compiled ahead of time: static HTML where nothing changes, small native handlers where it does, a React island only where React is needed. Docs for @brust/core 2.x.', '']
  for (const g of NAV) {
    lines.push(`## ${g.group}`, '')
    for (const i of g.items) lines.push(`- [${i.title}](${absolute(href(i.slug))})`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
