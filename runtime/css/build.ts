import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'

/** The directory that contains this file — runtime/css/. Two dirname() steps
 * reach the brust repo root where node_modules/tailwindcss is installed. */
const BRUST_ROOT = path.resolve(import.meta.dir, '..', '..')

/** Absolute path to tailwindcss/index.css inside brust's own node_modules.
 * Used by the customCssResolver so that `@import "tailwindcss"` always
 * resolves via brust's bundled copy regardless of where the entry CSS lives. */
const TAILWINDCSS_INDEX = path.join(BRUST_ROOT, 'node_modules', 'tailwindcss', 'index.css')

export interface BuildCssOptions {
  /** Absolute path to the entry CSS file (typically <scanRoot>/app.css). */
  entry: string
  /** Absolute path to the output directory. Created if missing. */
  outDir: string
}

export interface CssBuildResult {
  outDir: string
  files: string[]
}

export async function buildCss(opts: BuildCssOptions): Promise<CssBuildResult> {
  const sourceCss = await readFile(opts.entry, 'utf-8')

  const compiler = await compile(sourceCss, {
    // base: the entry CSS's directory so that @source globs resolve
    // relative to the entry file (e.g. @source "./**/*.tsx" scans
    // the same folder the CSS lives in).
    base: path.dirname(opts.entry),
    onDependency: () => {}, // unused — no watch
    // Redirect `@import "tailwindcss"` to brust's own bundled copy so
    // resolution succeeds even when tailwindcss is not installed in the
    // entry directory (e.g. a tmp dir in tests).
    customCssResolver: async (id: string) => {
      if (id === 'tailwindcss') return TAILWINDCSS_INDEX
      return undefined
    },
  })

  const scanner = new Scanner({ sources: compiler.sources })
  const candidates = scanner.scan()

  const output = compiler.build(candidates)

  await mkdir(opts.outDir, { recursive: true })
  await writeFile(path.join(opts.outDir, 'app.css'), output, 'utf-8')

  return { outDir: opts.outDir, files: ['app.css'] }
}
