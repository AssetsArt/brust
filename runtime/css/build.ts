import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'

/** Resolve `tailwindcss/index.css` starting from `fromDir`. Uses package.json
 * resolution (always present, unlike index.css in the exports map) then joins
 * index.css. Returns undefined if tailwindcss is not installed in that context.
 *
 * Tailwind is an opt-in dependency of the *consumer* project (the scaffold
 * declares it), NOT a hard dependency of brust core — so we resolve it from
 * the entry CSS's project first, falling back to brust's own context (which
 * covers the dev repo and unit tests where tailwindcss is hoisted). */
function resolveTailwindIndex(fromDir: string): string | undefined {
  try {
    const req = createRequire(path.join(fromDir, '__brust_resolve__.js'))
    return path.join(path.dirname(req.resolve('tailwindcss/package.json')), 'index.css')
  } catch {
    return undefined
  }
}

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
    // Resolve `@import "tailwindcss"` to the consumer project's own copy
    // (resolved from the entry CSS's directory), falling back to brust's own
    // context — the latter covers the dev repo and unit tests where the entry
    // lives in a tmp dir without its own tailwindcss install.
    customCssResolver: async (id: string) => {
      if (id !== 'tailwindcss') return undefined
      return resolveTailwindIndex(path.dirname(opts.entry)) ?? resolveTailwindIndex(import.meta.dir)
    },
  })

  const scanner = new Scanner({ sources: compiler.sources })
  const candidates = scanner.scan()

  const output = compiler.build(candidates)

  await mkdir(opts.outDir, { recursive: true })
  await writeFile(path.join(opts.outDir, 'app.css'), output, 'utf-8')

  return { outDir: opts.outDir, files: ['app.css'] }
}
