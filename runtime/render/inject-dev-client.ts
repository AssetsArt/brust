const ENC = new TextEncoder()

let warned = false

/** @internal — used by tests to reset the warn-once flag. */
export function _resetWarnedForTests(): void {
  warned = false
}

/** Splice `snippet` into `body` immediately before the first `</head>`
 * (case-insensitive on the four ASCII letters only). Returns the original body
 * untouched if `snippet` is null/empty or if `</head>` is absent. */
export function injectDevClient(body: Uint8Array, snippet: string | null): Uint8Array {
  if (!snippet) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) {
    if (!warned) {
      console.warn('[brust] dev: no </head> in first chunk; dev-client <script> not injected')
      warned = true
    }
    return body
  }
  const tagBytes = ENC.encode(snippet)
  const out = new Uint8Array(body.length + tagBytes.length)
  out.set(body.subarray(0, pos), 0)
  out.set(tagBytes, pos)
  out.set(body.subarray(pos), pos + tagBytes.length)
  return out
}

function findHeadCloseTag(body: Uint8Array): number {
  const LT = 0x3c,
    SL = 0x2f,
    GT = 0x3e
  for (let i = 0, max = body.length - 6; i < max; i++) {
    if (body[i] !== LT || body[i + 1] !== SL) continue
    if (!isLetter(body[i + 2], 0x48)) continue
    if (!isLetter(body[i + 3], 0x45)) continue
    if (!isLetter(body[i + 4], 0x41)) continue
    if (!isLetter(body[i + 5], 0x44)) continue
    if (body[i + 6] !== GT) continue
    return i
  }
  return -1
}

function isLetter(b: number, u: number): boolean {
  return b === u || b === (u | 0x20)
}
