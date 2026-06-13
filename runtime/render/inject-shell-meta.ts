// Render-time SPA shell-signature injection for React-streamed HTML. Mirrors
// inject-generator.ts exactly (the generator-meta dual-path precedent): the
// buffering branch splices `<meta name="brust-shell" content="…">` before
// </head> with a presence guard; the streaming branch (stream.ts) prepends the
// raw tag with the other first-chunk tags instead. The signature comes from the
// matched route's FlatRoute.shellId, threaded through RenderBranchStreamingArgs.
//
// The client (bootstrap.ts) reads this meta at boot and full-loads when a nav
// payload's `shell` differs — so a layout-chain change renders the correct shell.
const ENC = new TextEncoder()

/** Build the shell-signature meta tag for a given shellId (no escaping needed —
 * shellId is a server-derived `L:`/`S:` token of component names / route paths,
 * not user input). Empty → empty string (the inject path no-ops). */
export function shellMetaTag(shellId: string): string {
  return shellId ? `<meta name="brust-shell" content="${shellId}">` : ''
}

const GUARD = ENC.encode('name="brust-shell"')

/** Splice the shell meta immediately before the first `</head>` (case-insensitive).
 * No </head> in the chunk, empty shellId, or an existing brust-shell meta → body
 * returned untouched. Byte-level (no decode) — safe with multibyte content. */
export function injectShellMeta(body: Uint8Array, shellId: string): Uint8Array {
  if (!shellId) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) return body
  if (bytesInclude(body, GUARD, pos)) return body
  const tagBytes = ENC.encode(shellMetaTag(shellId))
  const out = new Uint8Array(body.length + tagBytes.length)
  out.set(body.subarray(0, pos), 0)
  out.set(tagBytes, pos)
  out.set(body.subarray(pos), pos + tagBytes.length)
  return out
}

/** True if `needle` occurs in `hay[0..limit)`. Naive scan — head is small. */
function bytesInclude(hay: Uint8Array, needle: Uint8Array, limit: number): boolean {
  const max = Math.min(limit, hay.length) - needle.length
  outer: for (let i = 0; i <= max; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/** Byte scan for `</head>` (letters case-insensitive). Returns offset of `<` or -1. */
function findHeadCloseTag(body: Uint8Array): number {
  const LT = 0x3c
  const SL = 0x2f
  const GT = 0x3e
  for (let i = 0, max = body.length - 6; i < max; i++) {
    if (body[i] !== LT || body[i + 1] !== SL) continue
    if (!isLetter(body[i + 2], 0x48)) continue // H
    if (!isLetter(body[i + 3], 0x45)) continue // E
    if (!isLetter(body[i + 4], 0x41)) continue // A
    if (!isLetter(body[i + 5], 0x44)) continue // D
    if (body[i + 6] !== GT) continue
    return i
  }
  return -1
}

function isLetter(b: number, u: number): boolean {
  return b === u || b === (u | 0x20)
}
