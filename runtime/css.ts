// Module-scope state read by the renderer to decide whether to inject
// <link rel="stylesheet"> tags into the first chunk. Mirrors the
// consume-flag pattern used by islands — per-worker (workers re-execute
// the bundle and get their own copy).
let cssHrefs: string[] = []

/** Configure the list of stylesheet hrefs that the renderer should
 * inject into the SSR HTML before </head>. Replaces any previous list.
 * Called from brust.run() main and worker branches (both need to know
 * so the per-worker renderer can inject). */
export function configureCssEnabled(hrefs: readonly string[]): void {
  cssHrefs = hrefs.slice()
}

/** Returns the configured hrefs as a defensive copy. */
export function getCssHrefs(): readonly string[] {
  return cssHrefs.slice()
}

const routeHrefs = new Map<string, readonly string[]>()

/** Set the CSS hrefs to inject for a specific route. Replaces any previous
 * list for that route. Called from brust.run() main after the component
 * manifest loads. Keys are route.fullPath strings (e.g. '/' or '/blog/{slug}'). */
export function configureCssHrefsForRoute(routePath: string, hrefs: readonly string[]): void {
  routeHrefs.set(routePath, hrefs.slice())
}

/** Returns the CSS hrefs for a specific route, or [] when none configured.
 * Defensive copy on the way out. */
export function getCssHrefsForRoute(routePath: string): readonly string[] {
  return (routeHrefs.get(routePath) ?? []).slice()
}

/** @internal — used by the unit test suite to wipe both global and per-route state. */
export function _resetCssForTests(): void {
  cssHrefs = []
  routeHrefs.clear()
}
