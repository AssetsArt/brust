// Packages the compiler RECOGNISES by what they are rather than reading their source (R34.140). A recognised package is
// pinned: the installed package.json `version` AND the SHA-256 of its published ESM entry must be one of the pairs below.
// Any other version, or the same version with another byte in the entry, is not recognised (its import stays the React
// island it is without it). The compiler is told only the package name and the verified version (`index.json#recognised`).
import { createHash } from 'node:crypto'

/** package name → published version → SHA-256 (hex) of the file `module` / `exports['.'].import` names. */
export const RECOGNISED: Record<string, Record<string, string>> = {
  // `createCollection` (the 3-tuple form roving focus, accordion, menus and slider use) of the 1.2.0 release
  '@radix-ui/react-collection': { '1.2.0': '52a6719c7c1a7a5202ab5ae58bb552f0d7853965a0833cf0e71749ac580e349f' },
}

/** The verified version of `name` when `version` and the bytes of its ESM `entry` are a pinned pair; else `null`. */
export function verifyRecognised(name: string, version: unknown, entryBytes: Uint8Array): string | null {
  const pins = RECOGNISED[name]
  if (!pins || typeof version !== 'string' || !Object.hasOwn(pins, version)) return null
  const sha = createHash('sha256').update(entryBytes).digest('hex')
  return sha === pins[version] ? version : null
}
