import { transform } from 'lightningcss'

export interface ProcessCssOptions {
  /** Absolute path; Lightning CSS uses this to derive [hash] in cssModules pattern. */
  filename: string
  /** Source CSS text. */
  source: string
  /** True iff this file is a .module.css. */
  isModule: boolean
  /** Optional Tailwind compiler. When set, source is piped through it FIRST
   * so @apply directives resolve before module class rewriting. Null when
   * Tailwind isn't available. */
  tailwindCompile: {
    build(candidates: string[]): string
    sources: { base: string; pattern: string; negated: boolean }[]
  } | null
}

export interface ProcessCssResult {
  /** Compiled CSS bytes. */
  code: Uint8Array
  /** null for non-module files; original→hashed name map for .module.css. */
  exports: Record<string, string> | null
}

/** Pipe a CSS file through Tailwind (if available) then Lightning CSS.
 * For .module.css, class names are hashed via Lightning's default
 * pattern `[local]_[hash]` where [hash] is file-derived (~6 chars).
 * Two classes in the same file share the suffix; two files with the same
 * class name get different hashes. */
export async function processCssFile(opts: ProcessCssOptions): Promise<ProcessCssResult> {
  let css = opts.source

  if (opts.tailwindCompile) {
    const { Scanner } = await import('@tailwindcss/oxide')
    const scanner = new Scanner({ sources: opts.tailwindCompile.sources })
    const candidates = scanner.scan()
    css = opts.tailwindCompile.build(candidates) + '\n' + css
  }

  const result = transform({
    filename: opts.filename,
    code: Buffer.from(css, 'utf-8'),
    cssModules: opts.isModule
      ? { pattern: '[local]_[hash]' }
      : false,
  })

  if (!opts.isModule) {
    return { code: result.code, exports: null }
  }

  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(result.exports ?? {})) {
    flat[k] = (v as { name: string }).name
  }
  return { code: result.code, exports: flat }
}
