import { storeScriptTag } from '../store/serialize.ts'

const ENC = new TextEncoder()
let warned = false

/** @internal — used by tests to reset the warn-once flag. */
export function _resetWarnedForTests(): void {
  warned = false
}

/** Build the combined `<script type="application/json">` blob for every touched
 * store. Returns '' when the snapshot is null/empty. */
export function buildStoreScripts(snap: Record<string, Record<string, unknown>> | null): string {
  if (!snap) return ''
  let out = ''
  for (const [name, state] of Object.entries(snap)) out += storeScriptTag(name, state)
  return out
}

/** Splice the store snapshot `<script>`(s) into `body` immediately before the
 * first `</head>`. Returns the original body untouched if the snapshot is
 * null/empty or if `</head>` is absent. */
export function injectBrustStore(
  body: Uint8Array,
  snap: Record<string, Record<string, unknown>> | null,
): Uint8Array {
  const scripts = buildStoreScripts(snap)
  if (!scripts) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) {
    if (!warned) {
      console.warn('[brust] store: no </head> in first chunk; snapshot not injected')
      warned = true
    }
    return body
  }
  const tagBytes = ENC.encode(scripts)
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
