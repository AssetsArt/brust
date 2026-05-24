const DIRECTIVE_HEAD_BYTES = 512

/** Remove leading whitespace, line comments (`//`), and block comments
 * from `src` and return the rest. Stops at the first non-trivial character.
 * Does NOT understand string literals — fine because we only run this on a
 * directive prologue, which by spec contains comments and the directive only.
 * If a block comment never terminates, returns '' so the caller treats the
 * file as non-server. */
export function stripLeadingTrivia(src: string): string {
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl === -1) return ''
      i = nl + 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return ''
      i = end + 2
      continue
    }
    break
  }
  return src.slice(i)
}

const USE_SERVER_PATTERN = /^(?:'use server'|"use server")\s*;?\s*(?:\r?\n|$)/

/** Read the first 512 bytes of `filePath` and return true iff a file-level
 * `'use server'` directive sits at the prologue position (before any import
 * or other statement). Comments and whitespace ahead of the directive are
 * skipped. Mirrors the TC39 directive-prologue rule. */
export async function hasUseServerDirective(filePath: string): Promise<boolean> {
  const f = Bun.file(filePath)
  const head = await f.slice(0, DIRECTIVE_HEAD_BYTES).text()
  const stripped = stripLeadingTrivia(head)
  return USE_SERVER_PATTERN.test(stripped)
}
