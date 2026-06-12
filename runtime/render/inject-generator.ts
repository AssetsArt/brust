// Render-time generator-meta injection for React-streamed HTML. The tag value
// comes from the build's generator.json (configured at boot by BOTH the main
// and worker isolates — module state is per-isolate, same trap as
// configureJinjaDir). Buffered branch: splice before </head> with a duplicate
// guard (a hand-authored generator meta wins). Streaming branch (stream.ts)
// prepends the raw tag with the other first-chunk tags instead — no guard
// possible there (head bytes arrive in later chunks); documented limitation.
const ENC = new TextEncoder()

let configured: string | null = null

/** Seed from generator.json at boot (main + worker). null → no injection. */
export function configureGeneratorMeta(meta: string | null): void {
  configured = meta
}

export function getGeneratorMeta(): string | null {
  return configured
}

const GUARD = ENC.encode('name="generator"')

/** Splice `metaTag` immediately before the first `</head>` (case-insensitive).
 * No </head> in the chunk, empty tag, or an existing generator meta → body
 * returned untouched. Byte-level (no decode) — safe with multibyte content. */
export function injectGeneratorMeta(body: Uint8Array, metaTag: string | null): Uint8Array {
  if (!metaTag) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) return body
  if (bytesInclude(body, GUARD, pos)) return body
  const tagBytes = ENC.encode(metaTag)
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

/** Byte scan for `</head>` (letters case-insensitive) — same approach as
 * inject-css-link.ts. Returns offset of `<` or -1. */
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
