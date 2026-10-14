// `tsconfig` `paths` aliases (shadcn S1, R34.76): `import … from "@/components/ui/button"` is a file of the app. The compiler
// resolves the specifiers that match an alias to the relative import of the file they name, from root-relative templates
// this module reads out of the app's own `tsconfig.json` / `jsconfig.json`. v1 reads that one file: no `extends`, no
// `references` (a named fallback below); exact and single-`*` patterns only. The bundler resolves the same specifiers
// natively; `checkAliasAgreement` fails the build if the two ever disagree.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { BuildError } from './errors'

export interface PathAlias {
  pattern: string
  targets: string[]
}

const FILES = ['tsconfig.json', 'jsconfig.json']

/** The aliases of the app's tsconfig, as root-relative `/`-separated templates; `notes` says what was left out and why. */
export function readPathAliases(appRoot: string): { aliases: PathAlias[]; notes: string[] } {
  const file = FILES.map((f) => join(appRoot, f)).find((f) => existsSync(f))
  if (!file) return { aliases: [], notes: [] }
  let json: { extends?: unknown; references?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } }
  try {
    json = Bun.JSONC.parse(readFileSync(file, 'utf8')) as typeof json
  } catch {
    return { aliases: [], notes: [`${relative(appRoot, file)} could not be parsed; its \`paths\` aliases are not followed`] }
  }
  const notes: string[] = []
  const paths = json?.compilerOptions?.paths
  if (json?.extends !== undefined || json?.references !== undefined)
    notes.push(
      `${relative(appRoot, file)} uses \`${json.extends !== undefined ? 'extends' : 'references'}\`, which brust does not follow: \`paths\` aliases written in another tsconfig stay package imports (put \`paths\` in ${relative(appRoot, file)})`,
    )
  if (!paths || typeof paths !== 'object') return { aliases: [], notes }
  const base = typeof json.compilerOptions?.baseUrl === 'string' ? json.compilerOptions.baseUrl : '.'
  const aliases: PathAlias[] = []
  for (const [pattern, raw] of Object.entries(paths as Record<string, unknown>)) {
    const stars = pattern.split('*').length - 1
    if (stars > 1 || !Array.isArray(raw)) {
      notes.push(`the \`paths\` pattern "${pattern}" is not an exact or single-\`*\` pattern; it is not followed`)
      continue
    }
    const targets: string[] = []
    for (const t of raw) {
      if (typeof t !== 'string' || (t.split('*').length - 1) > 1 || isAbsolute(t)) continue
      const rel = normalize(join(base, t)).split(sep).join('/')
      // Outside the app sources, or a package: not a file the compiler reads.
      if (rel.startsWith('..') || rel.includes('node_modules/')) continue
      targets.push(rel)
    }
    if (targets.length > 0) aliases.push({ pattern, targets })
  }
  return { aliases, notes }
}

/** The compiler's answer for every alias import must be the file the bundler resolves the same specifier to. */
export function checkAliasAgreement(appRoot: string, imports: { from: string; spec: string; target: string }[]): void {
  for (const { from, spec, target } of imports) {
    let got: string
    try {
      got = realpathSync(Bun.resolveSync(spec, dirname(join(appRoot, from))))
    } catch {
      throw new BuildError('alias-mismatch', `${from}: the compiler resolves "${spec}" to ${target}, but the bundler cannot resolve it (check tsconfig \`paths\`)`)
    }
    if (got !== realpathSync(join(appRoot, target)))
      throw new BuildError('alias-mismatch', `${from}: "${spec}" resolves to ${target} for the compiler but to ${relative(appRoot, got)} for the bundler (tsconfig \`paths\` is read differently); fix the alias or use a relative import`)
  }
}
