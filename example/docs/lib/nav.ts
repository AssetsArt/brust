// Docs chrome (sidebar + pager), precomputed per request in the layout-route
// loader — native templates can't call functions or compare values, so every
// boolean the template needs (per-item `active`) and every resolved object
// (`pager.prev`/`pager.next`) is computed HERE (spec §Docs chrome data flow).
//
// IMPORTANT: returns ONLY { nav, pager } — chain loaders merge top-down into
// one flat jinja context, and the md leaf loader contributes `__md` head
// fields; adding any other key here risks clobbering the leaf's.
import { mdNav } from 'brustjs/routes'

export interface DocsNavItem {
  title: string
  path: string
  /** Strict path equality against the requested path. The layout renders the
   * active item as a structurally separate branch (per-item ternary in the
   * `.map` body) so `aria-current="page"` appears ONLY on the active link. */
  active: boolean
}

export interface DocsNavGroup {
  group: string | null
  items: DocsNavItem[]
}

export interface DocsPagerLink {
  title: string
  path: string
}

export interface DocsChrome {
  nav: DocsNavGroup[]
  /** `prev`/`next` are optional — the layout tests the member directly
   * (`{pager.prev && <a href={pager.prev.path}>}`); the native compiler now
   * allows a truthiness test on a member alongside deeper reads of it. */
  pager: { prev?: DocsPagerLink; next?: DocsPagerLink }
}

/** Strip the query string and any trailing slash (except root) so the loader
 * `path` (full request path, may include `?…`) matches mdNav's urlPaths. */
function normalizePath(path: string): string {
  const bare = path.split('?', 1)[0].split('#', 1)[0]
  const trimmed = bare.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Sidebar + pager model for the docs layout. `contentDir` defaults to the
 * app's `content/` (cwd = example/docs at request time); tests pass a tmp dir.
 * Pager order is mdNav's flattened sorted sequence (groups in first-appearance
 * order, items sorted by `nav.order` then title).
 */
export function buildDocsChrome(path: string, contentDir = 'content'): DocsChrome {
  const current = normalizePath(path)
  const nav: DocsNavGroup[] = mdNav(contentDir).map((g) => ({
    group: g.group,
    items: g.items.map((i) => ({ title: i.title, path: i.path, active: i.path === current })),
  }))
  const flat = nav.flatMap((g) => g.items)
  const idx = flat.findIndex((i) => i.active)
  const pager: DocsChrome['pager'] = {}
  const prev = idx > 0 ? flat[idx - 1] : undefined
  if (prev) pager.prev = { title: prev.title, path: prev.path }
  const next = idx !== -1 && idx < flat.length - 1 ? flat[idx + 1] : undefined
  if (next) pager.next = { title: next.title, path: next.path }
  return { nav, pager }
}
