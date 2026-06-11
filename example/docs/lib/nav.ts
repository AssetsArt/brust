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
  /** `hasPrev`/`hasNext` are the inline-conditional TESTS for the layout: a
   * native cond test on `pager.prev` itself would infer the member as a
   * scalar and conflict with the deeper `pager.prev.path`/`.title` reads
   * (compiler PropTypeConflict) — so the booleans are precomputed siblings.
   * `prev`/`next` are ALWAYS present (empty-string sentinels when absent):
   * non-optional keeps the layout's `pager.prev.path` reads type-safe, and
   * the native compiler can't lower optional chaining (`pager?.prev?.path`
   * broke the build once — only plain member paths compile). */
  pager: { hasPrev: boolean; hasNext: boolean; prev: DocsPagerLink; next: DocsPagerLink }
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
  const pager: DocsChrome['pager'] = {
    hasPrev: false,
    hasNext: false,
    prev: { title: '', path: '' },
    next: { title: '', path: '' },
  }
  if (idx > 0) {
    pager.hasPrev = true
    pager.prev = { title: flat[idx - 1].title, path: flat[idx - 1].path }
  }
  if (idx !== -1 && idx < flat.length - 1) {
    pager.hasNext = true
    pager.next = { title: flat[idx + 1].title, path: flat[idx + 1].path }
  }
  return { nav, pager }
}
