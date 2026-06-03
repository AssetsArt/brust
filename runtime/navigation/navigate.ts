// runtime/navigation/navigate.ts — public imperative SPA navigation for
// brustjs/navigation. DOM-free at import (touches location/history only at call
// time, like active-nav.ts); delegates the swap to the navigator bootstrap
// registers, so this module never imports DOM/island code.
import { _getNavigator } from './store.ts'

export type QueryValue = string | number | boolean
export type QueryInit = Record<string, QueryValue | null | undefined | ReadonlyArray<QueryValue>>
export interface NavigateOptions {
  query?: QueryInit
  replace?: boolean
}

function applyQuery(params: URLSearchParams, query: QueryInit): void {
  for (const key of Object.keys(query)) {
    const v = query[key]
    params.delete(key)
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      for (const item of v) params.append(key, String(item))
    } else {
      params.append(key, String(v as QueryValue))
    }
  }
}

/** Serialize a query object to a `?...` string (or '' when empty). Pure, DOM-free. */
export function buildSearch(query: QueryInit): string {
  const params = new URLSearchParams()
  applyQuery(params, query)
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** Programmatic SPA navigation. Resolves `path` against the current location,
 * merges `options.query` over any query already in `path` (each key replaces all
 * base occurrences; null/undefined deletes), then delegates to the registered
 * navigator (full SPA swap + nav-state lifecycle). No navigator registered (no
 * islands bootstrap) → full-document load so the call still navigates. */
export async function navigate(path: string, options?: NavigateOptions): Promise<void> {
  // navigate() is a client-only action (resolves against location + drives the DOM
  // swap). Guard the bare `location` access so a server-side call surfaces a
  // legible error instead of a raw `ReferenceError` (mirrors active-nav.ts's
  // typeof-guard discipline; see the SSR non-goal in the design).
  if (typeof location === 'undefined') {
    throw new Error(
      '[brust] navigate() is a client-only action — no location/DOM available (called during SSR?)',
    )
  }
  const url = new URL(path, location.href)
  if (options?.query) applyQuery(url.searchParams, options.query)
  const nav = _getNavigator()
  if (nav) {
    await nav(url, options?.replace ?? false)
  } else {
    location.assign(url.href)
  }
}
