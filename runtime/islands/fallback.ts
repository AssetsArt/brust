// runtime/islands/fallback.ts — client takeover runtime for `fallback: 'client'`
// SSG routes (Phase B of the ssg-dynamic-params design). A non-prerendered
// dynamic path serves a placeholder shell whose leaf is
// `<div data-brust-fallback-root data-brust-fallback="<pattern>">…</div>`;
// this module matches the pattern against the live pathname, loads the
// route's fallback chunk (`Component` + `clientLoader`), and client-renders
// the real page into the container.
//
// Imported BY bootstrap.ts (Task B6): react / react-dom/client are static
// imports on purpose — bootstrap bundles them as externals resolved via the
// importmap, and this module rides the same bundle. Import-safe without a
// DOM: nothing touches document/location at module top level.

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export interface FallbackEntry {
  pattern: string
  doc: string
  payload: string
  chunk: string
}

// React roots created by takeover, keyed by their container, so navigation
// can unmount them before replacing the DOM (a detached live root keeps
// React's scheduler posting work to dead nodes — hung tab). Same discipline
// as bootstrap's islandRoots.
const fallbackRoots = new WeakMap<HTMLElement, Root>()

/** Match a route pattern (`/blog/{slug}`) against a concrete pathname.
 * Segment-wise: lengths must agree, `{name}` segments capture one
 * decodeURIComponent-decoded segment (malformed percent-encoding falls back
 * to the raw segment; an EMPTY segment never matches a capture), everything
 * else must compare literally. Returns the captured params, or null. */
export function matchFallback(pattern: string, pathname: string): Record<string, string> | null {
  const pat = pattern.split('/')
  // Route-table patterns never carry a trailing slash; static hosts (CF Pages
  // directory rewrites among them) may append one to the live pathname —
  // normalize so '/blog/foo/' still matches '/blog/{slug}'.
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const path = normalized.split('/')
  if (pat.length !== path.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i] as string
    const seg = path[i] as string
    if (p.startsWith('{') && p.endsWith('}') && p.length > 2) {
      if (seg === '') return null // empty capture → no match
      let value: string
      try {
        value = decodeURIComponent(seg)
      } catch {
        value = seg // malformed percent-encoding → raw segment
      }
      params[p.slice(1, -1)] = value
    } else if (p !== seg) {
      return null
    }
  }
  return params
}

let manifestPromise: Promise<FallbackEntry[]> | null = null

function isFallbackEntry(e: unknown): e is FallbackEntry {
  if (typeof e !== 'object' || e === null) return false
  const r = e as Record<string, unknown>
  return (
    typeof r.pattern === 'string' && typeof r.payload === 'string' && typeof r.chunk === 'string'
  )
}

/** Fetch the static-export fallback manifest (`/_brust/routes.json`).
 * Memoized for the document's lifetime — including the EMPTY result: a site
 * with no fallback routes (404 / invalid / no `fallbacks` array) resolves []
 * once and never refetches per navigation. Entries missing a string
 * pattern/payload/chunk are filtered out. */
export function loadFallbackManifest(): Promise<FallbackEntry[]> {
  if (!manifestPromise) {
    manifestPromise = fetch('/_brust/routes.json')
      .then(async (resp) => {
        if (!resp.ok) return []
        const json = (await resp.json()) as { fallbacks?: unknown }
        if (!Array.isArray(json.fallbacks)) return []
        return json.fallbacks.filter(isFallbackEntry)
      })
      .catch(() => [])
  }
  return manifestPromise
}

function takeoverError(container: HTMLElement, message: string, err?: unknown): void {
  if (err === undefined) console.error(`[brust] fallback: ${message}`)
  else console.error(`[brust] fallback: ${message}`, err)
  container.setAttribute('data-brust-fallback-error', '1')
}

/** Client-render a fallback route into its placeholder container.
 *
 * Reads the route pattern from `data-brust-fallback`, derives params from
 * `location.pathname`, dynamic-imports the route's fallback chunk from the
 * manifest, runs `clientLoader({ params, path })`, then replaces the
 * placeholder children with `createRoot(container).render(<Component
 * params path data />)` — the server prop shape minus `req`/`workerId`
 * (those don't exist in a browser).
 *
 * On any failure (mismatched pattern, missing manifest entry, bad chunk,
 * clientLoader throw) the container KEEPS its placeholder, gets a
 * `data-brust-fallback-error` attribute, and the error is logged —
 * author-level recovery is a catch inside clientLoader returning
 * error-shaped data.
 *
 * CONTRACT: the caller must unmount any island roots inside the container
 * FIRST (a placeholder may carry islands) — bootstrap's unmountIslandsIn
 * does this before calling takeover. The call lives there, not here, to
 * avoid a circular import between fallback.ts and bootstrap.ts.
 *
 * `signal`: a superseding navigation aborts it. Checked after every await and
 * BEFORE createRoot — without that gate, a takeover resumed after the next
 * navigation's swap would mount a React root into a DETACHED container that
 * unmountFallbackRootsIn can never find again (hung-tab hazard). */
export async function takeover(container: HTMLElement, signal?: AbortSignal): Promise<void> {
  const pattern = container.getAttribute('data-brust-fallback')
  if (pattern === null) {
    console.error('[brust] fallback: container has no data-brust-fallback attribute')
    return
  }
  const path = location.pathname
  const params = matchFallback(pattern, path)
  if (params === null) {
    takeoverError(container, `pattern "${pattern}" does not match pathname "${path}"`)
    return
  }
  const manifest = await loadFallbackManifest()
  const entry = manifest.find((e) => e.pattern === pattern)
  if (!entry) {
    takeoverError(container, `no manifest entry for pattern "${pattern}"`)
    return
  }
  let Component: React.ComponentType<Record<string, unknown>>
  let clientLoader: (args: { params: Record<string, string>; path: string }) => unknown
  try {
    // Variable specifier → stays a runtime dynamic import in the bundle
    // (same trick as bootstrap's islandChunkMap).
    const chunkUrl = entry.chunk
    const mod = (await import(chunkUrl)) as Record<string, unknown>
    if (typeof mod.Component !== 'function' || typeof mod.clientLoader !== 'function') {
      takeoverError(container, `chunk "${entry.chunk}" must export Component and clientLoader`)
      return
    }
    Component = mod.Component as React.ComponentType<Record<string, unknown>>
    clientLoader = mod.clientLoader as typeof clientLoader
  } catch (e) {
    takeoverError(container, `failed to load chunk "${entry.chunk}"`, e)
    return
  }
  if (signal?.aborted) return
  let data: unknown
  try {
    data = await clientLoader({ params, path })
  } catch (e) {
    takeoverError(container, `clientLoader threw for "${pattern}"`, e)
    return
  }
  // Superseded while the data was loading → the newer navigation owns the
  // DOM; mounting here would render into a detached container.
  if (signal?.aborted) return
  // Success: drop the placeholder, then mount a fresh client root.
  while (container.firstChild) container.removeChild(container.firstChild)
  const root = createRoot(container)
  root.render(createElement(Component, { params, path, data }))
  fallbackRoots.set(container, root)
}

/** Unmount any takeover roots inside `scope`. Must run BEFORE removing or
 * replacing their DOM (same reason as bootstrap's unmountIslandsIn, which
 * delegates here in Task B6 — islandRoots and fallbackRoots stay
 * module-private to their owners). */
export function unmountFallbackRootsIn(scope: ParentNode): void {
  const containers = scope.querySelectorAll<HTMLElement>('[data-brust-fallback-root]')
  for (const el of Array.from(containers)) {
    const root = fallbackRoots.get(el)
    if (root) {
      try {
        root.unmount()
      } catch (e) {
        console.warn('[brust] fallback root unmount failed', e)
      }
      fallbackRoots.delete(el)
    }
  }
}

// Test-only: drop the memoized manifest so the next loadFallbackManifest
// refetches. (fallbackRoots is a WeakMap — nothing to clear.)
export function __resetFallbackForTest(): void {
  manifestPromise = null
}
