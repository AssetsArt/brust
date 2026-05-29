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
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

/** One entry of a `<template>.islands.json` manifest (enriched by T6). */
export interface NativeIslandEntry {
  component: string
  instance: number
  propsPath: string
  ssr: boolean
  hydrate: string
  sourcePath: string
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
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of manifest) {
    const props = pathInto(data, entry.propsPath)
    // `?? null` handles undefined props; the `?? 'null'` belt-and-braces covers
    // the case where JSON.stringify itself returns undefined (e.g. a function
    // value), so entityEncode never receives undefined.
    out['island_' + entry.instance + '_props'] = entityEncode(
      JSON.stringify(props ?? null) ?? 'null',
    )
    if (!entry.ssr) continue
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
      out['island_' + entry.instance + '_html'] = renderToString(
        createElement(Component as any, (props ?? undefined) as any),
      )
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
