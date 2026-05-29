const ENC = new TextEncoder()

/** Set to true on the first miss; suppresses subsequent warnings so a
 * misconfigured Layout doesn't flood logs. Test helper resets this. */
let warned = false

/** @internal — used by the unit test suite to reset the warn-once flag. */
export function _resetWarnedForTests(): void {
  warned = false
}

/** Splice `<link rel="stylesheet" href="...">` tags into `body` immediately
 * before the first occurrence of `</head>` (case-insensitive). Returns the
 * original body untouched if `hrefs` is empty or if `</head>` is absent
 * (warns once in the latter case). Renderer calls this on the first chunk
 * only — see spec §"SSR <link> injection". */
export function injectCssLink(body: Uint8Array, hrefs: readonly string[]): Uint8Array {
  if (hrefs.length === 0) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) {
    if (!warned) {
      console.warn('[brust] css: no </head> in first chunk; <link> not injected')
      warned = true
    }
    return body
  }
  const tags = hrefs.map((h) => `<link rel="stylesheet" href="${h}">`).join('')
  const tagsBytes = ENC.encode(tags)
  const out = new Uint8Array(body.length + tagsBytes.length)
  out.set(body.subarray(0, pos), 0)
  out.set(tagsBytes, pos)
  out.set(body.subarray(pos), pos + tagsBytes.length)
  return out
}

/** Byte-level scan for `</head>` (case-insensitive on the four letters).
 * Returns the byte offset of the `<` or -1 if not found. */
function findHeadCloseTag(body: Uint8Array): number {
  // Target bytes: `<` `/` H E A D `>`  — 7 bytes total.
  // We only case-fold the four ASCII letters; the angle/slash bytes are exact.
  const LT = 0x3c // <
  const SL = 0x2f // /
  const GT = 0x3e // >
  for (let i = 0, max = body.length - 6; i < max; i++) {
    if (body[i] !== LT || body[i + 1] !== SL) continue
    if (!isLetter(body[i + 2], 0x48)) continue // H/h
    if (!isLetter(body[i + 3], 0x45)) continue // E/e
    if (!isLetter(body[i + 4], 0x41)) continue // A/a
    if (!isLetter(body[i + 5], 0x44)) continue // D/d
    if (body[i + 6] !== GT) continue
    return i
  }
  return -1
}

/** Returns true if `b` matches the upper-case letter `u` (b === u || b === u|0x20). */
function isLetter(b: number, u: number): boolean {
  return b === u || b === (u | 0x20)
}
