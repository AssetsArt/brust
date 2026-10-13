// Tailwind CSS v4 for `brust build` (L32, F135, R33.1-R33.4): brust's own Bun plugin over the app's Tailwind.
// It does what the official integrations (@tailwindcss/vite, @tailwindcss/postcss) do: `compile()` from
// `@tailwindcss/node`, a `Scanner` from `@tailwindcss/oxide` over the compiler's sources (the app root unless the
// stylesheet says `source(...)`, plus every `@source` / `@source not`), then `build(candidates)`. Both packages are
// resolved from the APP, never bundled into or depended on by brust, so the compiler is the app's pinned
// `tailwindcss` (`@tailwindcss/node` depends on its own exact `tailwindcss`; the app installs all three at one
// version, and a mismatch is a loud warning with the command that aligns them).
import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import type { BunPlugin } from 'bun'
import { BuildError } from './errors'

/** The install set (R33.2): one exact version for all three. */
export const TAILWIND_PACKAGES = ['tailwindcss', '@tailwindcss/node', '@tailwindcss/oxide'] as const

interface SourceEntry {
  base: string
  pattern: string
  negated: boolean
}
interface Compiler {
  root: 'none' | { base: string; pattern: string } | null
  sources: SourceEntry[]
  build(candidates: string[]): string
}
interface TailwindNode {
  compile(css: string, o: { base: string; from?: string; shouldRewriteUrls?: boolean; onDependency: (path: string) => void }): Promise<Compiler>
}
interface TailwindOxide {
  Scanner: new (o: { sources: SourceEntry[] }) => { scan(): string[] }
}

/** The `version` of `pkg` as resolved from `from` (a directory), or undefined when it does not resolve. */
function versionFrom(pkg: string, from: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(Bun.resolveSync(`${pkg}/package.json`, from), 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
}

/** The versions that decide what compiles (R33.3): the app's `tailwindcss`, the `tailwindcss` that
 * `@tailwindcss/node` imports (the compiler), and the two integration packages. */
export function tailwindVersions(appRoot: string): { app?: string; compiler?: string; node?: string; oxide?: string } {
  let compiler: string | undefined
  try {
    compiler = versionFrom('tailwindcss', dirname(Bun.resolveSync('@tailwindcss/node/package.json', appRoot)))
  } catch {}
  return { app: versionFrom('tailwindcss', appRoot), compiler, node: versionFrom('@tailwindcss/node', appRoot), oxide: versionFrom('@tailwindcss/oxide', appRoot) }
}

const addCommand = (v: string) => `bun add -d --exact ${TAILWIND_PACKAGES.map((p) => `${p}@${v}`).join(' ')}`

/** The Tailwind plugin of the CSS build, resolved from the app. Missing packages → `tailwind-missing` with the
 * exact install command; versions that differ → one warning through `log` with the command that aligns them.
 * `uses(file)` says whether a stylesheet needs the compiler (it, or a relative `@import` of it, uses Tailwind);
 * other stylesheets stay Bun's. */
export async function loadTailwind(appRoot: string, usedBy: string, uses: (file: string) => boolean, log?: (s: string) => void): Promise<BunPlugin> {
  const v = tailwindVersions(appRoot)
  const missing = TAILWIND_PACKAGES.filter((p) => versionFrom(p, appRoot) === undefined)
  if (missing.length > 0)
    throw new BuildError(
      'tailwind-missing',
      `${relative(appRoot, usedBy)} uses Tailwind CSS, but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not installed in the app: run \`${v.app ? addCommand(v.app) : `bun add -d ${TAILWIND_PACKAGES.map((p) => `${p}@4`).join(' ')}`}\``,
    )
  if (new Set([v.app, v.compiler, v.node, v.oxide]).size > 1)
    log?.(
      `[brust] warning tailwind-version the app has tailwindcss ${v.app}, but the compiler is tailwindcss ${v.compiler} (@tailwindcss/node ${v.node}, @tailwindcss/oxide ${v.oxide}): install one version of all three: ${addCommand(v.app!)}`,
    )
  const node = (await import(Bun.resolveSync('@tailwindcss/node', appRoot))) as TailwindNode
  const oxide = (await import(Bun.resolveSync('@tailwindcss/oxide', appRoot))) as TailwindOxide
  return {
    name: 'brust-tailwind',
    setup(b) {
      b.onLoad({ filter: /\.css$/ }, async (a) => {
        if (!uses(a.path)) return undefined // Bun's own loader (CSS Modules included)
        const css = readFileSync(a.path, 'utf8')
        const compiler = await node.compile(css, { base: dirname(a.path), from: a.path, shouldRewriteUrls: true, onDependency: () => {} })
        const root: SourceEntry[] =
          compiler.root === 'none' ? [] : compiler.root === null ? [{ base: appRoot, pattern: '**/*', negated: false }] : [{ ...compiler.root, negated: false }]
        const scanner = new oxide.Scanner({ sources: [...root, ...compiler.sources] })
        let out = compiler.build(scanner.scan())
        // `@reference "./app.css"` pulls in Tailwind's license banner too; only the file that imports Tailwind ships it
        // (one banner per page, as before)
        if (!/@import\s+(?:url\(\s*)?["']tailwindcss["']/.test(css)) out = out.replace(/\/\*! tailwindcss v[^*]*\*\/\s*/g, '')
        return { contents: out, loader: 'css' }
      })
    },
  }
}
