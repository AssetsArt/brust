// Heading-anchor slugger — the SINGLE source of truth for the ids brust stamps
// on markdown `<h2>/<h3>`. render.ts uses it when emitting heading ids, and it
// is re-exported on `brustjs/routes` so a consumer (e.g. a search-index
// generator) can compute the SAME anchors without copying this logic — which
// is exactly the parity that used to drift (FRAMEWORK-GAPS G1).
//
// `\w` is ASCII-only: non-ascii heading text strips to nothing (matches marked
// GFM's behavior as wired here). Per-page duplicate-id disambiguation
// (`-2`, `-3`, …) is the caller's concern — render.ts keeps a page-local count.
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
}
