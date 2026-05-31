// Native-jinja island plumbing (Sub-project J / T7).
//
// When a native (minijinja) route has an islands manifest, the loader's
// return value is augmented with per-island context variables before the
// JSON is shipped into the SAB for napi_render_jinja. Each island i
// contributes `island_<instance>_props` — the island's props, resolved out of
// the loader data via a dotted path, JSON-stringified, and HTML-entity-encoded
// so the value is safe to substitute RAW into a double-quoted attribute (brust's
// minijinja env has NO autoescape).
//
// T9 SCOPE: ssr islands ALSO contribute `island_<instance>_html` — the island's
// SOURCE component, imported by absolute path and renderToString'd server-side.
// Client-only islands (ssr:false) still contribute only `_props`. This makes
// resolveIslandContext async (it awaits the dynamic import of each ssr source).

import { readFileSync } from 'node:fs'
import path from 'node:path'
// .node build: keep a single react-dom/server build loaded across the runtime
// (the streaming paths need server.node's renderToPipeableStream). See routes.ts.
import { renderToString } from 'react-dom/server.node'
import { createElement } from 'react'

/** One entry of a `<template>.islands.json` manifest (enriched by T6). */
export interface NativeIslandEntry {
  component: string
  instance: number
  propsPath: string
  ssr: boolean
  hydrate: string
  sourcePath: string
  /** Dotted path into loader data yielding the ISR cache key (string). */
  keyPath?: string
  /** Dotted path into loader data yielding the ISR cache tags (string[]). */
  tagsPath?: string
  /** Revalidate window in SECONDS; converted to ttlMs on cache.set. */
  revalidate?: number
}

/** Rust-side ISR cache, injected as a port for testability. A `get` hit
 * returns a FROZEN {html,props} pair (the props are the entity-encoded attr
 * string, identical to what was stored) so the served markup and the hydrated
 * props stay byte-identical regardless of live loader-data mutation. */
export interface IslandCache {
  get(key: string): { html: string; props: string } | null
  set(key: string, tags: string[], ttlMs: number | undefined, html: string, props: string): void
}

/** Walk a dotted path into `data`. Each segment must be an OWN enumerable
 * property — inherited keys (`constructor`, `__proto__`, `toString`, …) yield
 * `undefined` rather than traversing the prototype chain. This blocks both
 * prototype-pollution-style reads AND the downstream crash where a resolved
 * function (`Object`) makes `JSON.stringify` return `undefined`. A missing
 * segment, a nullish/primitive cursor, or a non-own key all yield `undefined`.
 * An empty path returns `data` itself. */
export function pathInto(data: unknown, propsPath: string): unknown {
  if (propsPath === '') return data
  let cur: unknown = data
  for (const seg of propsPath.split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** HTML-entity-encode a string for a double-quoted attribute value. Order is
 * load-bearing: `&` MUST be replaced first so the entities introduced by the
 * later replacements aren't themselves double-encoded. Matches the compiler's
 * `push_attr_escaped` charset (& < > ") so server-rendered markup and these
 * props attrs stay consistent. */
export function entityEncode(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Manifests are boot-only/immutable (same as the Rust template registry), so
// cache by absolute path. We cache BOTH hits and misses (null): a native
// route with no islands would otherwise pay a throw-and-catch readFileSync on
// every request, and the immutability guarantee means a missing file won't
// appear later at runtime. `null` is a valid cache value, so the cache must be
// keyed on `has()`, not `get() !== undefined`.
const manifestCache = new Map<string, NativeIslandEntry[] | null>()

/** Read `<jinjaDir>/<templateName>.islands.json` and return the parsed entry
 * array, or `null` if the file doesn't exist. `jinjaDir` defaults to
 * `process.cwd()/.brust/jinja`; tests pass a temp dir. Both hits and misses
 * are cached by absolute path. */
export function loadIslandManifest(
  templateName: string,
  jinjaDir?: string,
): NativeIslandEntry[] | null {
  const dir = jinjaDir ?? path.resolve(process.cwd(), '.brust/jinja')
  const abs = path.resolve(dir, `${templateName}.islands.json`)
  if (manifestCache.has(abs)) return manifestCache.get(abs)!
  let parsed: NativeIslandEntry[] | null
  try {
    // JSON.parse is INSIDE the try: a present-but-malformed manifest must
    // degrade to null (cached), not throw out of the fast-lane native branch
    // (which runs past the request try/catch — an unguarded throw there is an
    // unhandled rejection that hangs the request instead of a clean fallback).
    parsed = JSON.parse(readFileSync(abs, 'utf8')) as NativeIslandEntry[]
  } catch {
    manifestCache.set(abs, null)
    return null
  }
  manifestCache.set(abs, parsed)
  return parsed
}

// Cache imported island modules by sourcePath (Bun caches the import anyway;
// this avoids repeated default-export resolution).
const componentCache = new Map<string, unknown>()

/** Build the per-island context additions for a manifest. Each entry
 * contributes `island_<instance>_props` — the resolved props, JSON-stringified
 * (undefined → null so it stays valid JSON) and entity-encoded. SSR entries
 * (`ssr:true`) ALSO contribute `island_<instance>_html` — the island source
 * component imported by absolute path and renderToString'd. The `instance` is a
 * per-occurrence integer, so it's a safe key fragment. */
export async function resolveIslandContext(
  manifest: NativeIslandEntry[],
  data: unknown,
  cache?: IslandCache,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of manifest) {
    const props = pathInto(data, entry.propsPath)
    // `?? null` handles undefined props; the `?? 'null'` belt-and-braces covers
    // the case where JSON.stringify itself returns undefined (e.g. a function
    // value), so entityEncode never receives undefined. Hoisted ABOVE the ssr
    // branch so the SAME attr string is stored in (and served from) the cache
    // AND hydrated against — byte-identity is the ISR hydration-safety invariant.
    const propsAttr = entityEncode(JSON.stringify(props ?? null) ?? 'null')
    out['island_' + entry.instance + '_props'] = propsAttr
    if (!entry.ssr) continue

    // ISR fast-path: resolve a string cache key out of loader data. A hit
    // serves the FROZEN {html,props} pair (overwriting the live _props with the
    // stored one) and skips render. A non-string-but-defined key is a manifest
    // bug — warn and fall through to an uncached render.
    let key: string | undefined
    if (cache && entry.keyPath) {
      const k = pathInto(data, entry.keyPath)
      if (typeof k === 'string') {
        key = k
        const hit = cache.get(key)
        if (hit) {
          out['island_' + entry.instance + '_html'] = hit.html
          out['island_' + entry.instance + '_props'] = hit.props
          continue
        }
      } else if (k !== undefined) {
        console.warn(
          `[brust] ssr island "${entry.component}" ISR keyPath "${entry.keyPath}" resolved to a non-string value; rendering uncached`,
        )
      }
    }

    try {
      let Component = componentCache.get(entry.sourcePath)
      if (Component === undefined) {
        const mod = await import(entry.sourcePath)
        Component = mod.default ?? mod
        componentCache.set(entry.sourcePath, Component)
      }
      if (typeof Component !== 'function') {
        throw new Error(`island "${entry.component}" source has no default-exported component`)
      }
      // Render from the SAME (roundtripped) props value the client gets via
      // JSON.parse(data-brust-props) — byte-identity guarantees no hydration
      // mismatch. props ?? undefined: pass the actual value (or undefined) to
      // the component, NOT the `null` sentinel used for the props string.
      const html = renderToString(createElement(Component as any, (props ?? undefined) as any))
      out['island_' + entry.instance + '_html'] = html
      // Write-through: only on the SUCCESS path (a throwing render must not
      // poison the cache). Store the SAME entity-encoded propsAttr so a later
      // hit hydrates byte-identically.
      if (cache && key) {
        // Resolve tags only when tagsPath is set (avoids pathInto('') returning
        // the whole loader object). Must be a string[] — the value crosses to
        // Rust as Vec<String>, so a non-array OR an array with a non-string
        // element degrades to no tags + a warning, never a bad NAPI payload.
        let tags: string[] = []
        if (entry.tagsPath !== undefined) {
          const tagsValue = pathInto(data, entry.tagsPath)
          if (Array.isArray(tagsValue) && tagsValue.every((t) => typeof t === 'string')) {
            tags = tagsValue
          } else if (tagsValue !== undefined) {
            console.warn(
              `[brust] ssr island "${entry.component}" ISR tagsPath "${entry.tagsPath}" must resolve to a string[]; using no tags`,
            )
          }
        }
        const ttlMs = entry.revalidate !== undefined ? entry.revalidate * 1000 : undefined
        cache.set(key, tags, ttlMs, html, propsAttr)
      }
    } catch (e) {
      // CONTAINED FAILURE (spec invariant): a throwing ssr island degrades to
      // an empty mount (no _html) + logged warning, rather than 500-ing the
      // page. The mount has no data-brust-csr, so the client will client-render
      // it via hydrateRoot's React-19 mismatch recovery (noisy but functional).
      console.error(
        `[brust] ssr island "${entry.component}" renderToString failed; degrading to client-only:`,
        e,
      )
      // leave _html unset → empty mount
    }
  }
  return out
}

/** One entry in `<Name>.components.json` as enriched by `emitComponentArtifacts`. */
export interface NativeComponentEntry {
  component: string
  instance: number
  sourcePath: string
}

// Cache component manifests by absolute path (same pattern as island manifests).
const componentManifestCache = new Map<string, NativeComponentEntry[] | null>()

/** Read `<jinjaDir>/<templateName>.components.json` and return the parsed entry
 * array, or `null` if the file doesn't exist. Both hits and misses are cached
 * by absolute path (same invariant as `loadIslandManifest`). */
export function loadComponentManifest(
  templateName: string,
  jinjaDir?: string,
): NativeComponentEntry[] | null {
  const dir = jinjaDir ?? path.resolve(process.cwd(), '.brust/jinja')
  const abs = path.resolve(dir, `${templateName}.components.json`)
  if (componentManifestCache.has(abs)) return componentManifestCache.get(abs)!
  let parsed: NativeComponentEntry[] | null
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8')) as NativeComponentEntry[]
  } catch {
    componentManifestCache.set(abs, null)
    return null
  }
  componentManifestCache.set(abs, parsed)
  return parsed
}

// Cache factory modules by absolute path.
const factoryCache = new Map<string, { factories: Array<(ctx: unknown) => unknown> } | null>()

/** Build the per-component context additions for a manifest. Each entry
 * contributes `comp_<instance>_html` — the component rendered to HTML by
 * the route's factory function. On `renderToString` failure: degrade to
 * `comp_N_html = ""` and log, mirrors SSR island failure behaviour. */
export async function resolveComponentContext(
  manifest: NativeComponentEntry[],
  data: unknown,
  templateName: string,
  jinjaDir?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!manifest.length) return out

  const dir = jinjaDir ?? path.resolve(process.cwd(), '.brust/jinja')
  const factoryPath = path.resolve(dir, `${templateName}.factory.ts`)

  let factoryMod = factoryCache.get(factoryPath)
  if (factoryMod === undefined) {
    try {
      factoryMod = (await import(factoryPath)) as {
        factories: Array<(ctx: unknown) => unknown>
      }
    } catch {
      factoryMod = null
    }
    factoryCache.set(factoryPath, factoryMod)
  }

  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i]!
    try {
      if (!factoryMod?.factories?.[i]) {
        throw new Error(`factory[${i}] not found in ${factoryPath}`)
      }
      const node = factoryMod.factories[i]!(data)
      out[`comp_${i}_html`] = renderToString(node as React.ReactNode)
    } catch (e) {
      console.error(
        `[brust] SSR component "${entry.component}" renderToString failed; degrading to empty:`,
        e,
      )
      out[`comp_${i}_html`] = ''
    }
  }
  return out
}
