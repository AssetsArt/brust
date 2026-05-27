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
