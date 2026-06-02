import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ScaffoldCtx {
  projectName: string
  /** Raw brust dep spec, e.g. "file:/abs/path" or "^0.1.16-alpha". */
  brustSpec: string
}

export interface EmittedFile {
  /** POSIX-relative destination path under the project root. */
  relPath: string
  content: string
}

export interface TemplateDef {
  name: string
  title: string
  description: string
  sourceDir: string
  /**
   * POSIX-relative paths (from sourceDir) to skip when copying. Matching uses
   * the SOURCE entry name (pre-`renameForEmit`), so to exclude an emitted
   * `.gitignore` you list its source name `_gitignore`, not `.gitignore`.
   */
  exclude: Set<string>
  /** Files the source tree lacks, generated at scaffold time. */
  extraFiles?: (ctx: ScaffoldCtx) => EmittedFile[]
}

export const DEFAULT_TEMPLATE = 'minimal'

const MINIMAL_DIR = join(import.meta.dir, 'templates', 'minimal')

/**
 * Walk up from `startDir` to the directory of the nearest package.json whose
 * `name === 'brustjs'`. Single source of truth for locating the brust package
 * root (consumed by both `resolveBrustRef` and pokedex template resolution).
 * Works in the source tree (repo root) and a published install
 * (`node_modules/brustjs`). Throws if no such package.json is found.
 */
export function findBrustPackageRoot(startDir: string = import.meta.dir): string {
  let dir = startDir
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name === 'brustjs') return dir
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('brust new: cannot locate the brust package — is your installation intact?')
    }
    dir = parent
  }
}

function pokedexExtraFiles(ctx: ScaffoldCtx): EmittedFile[] {
  // pokedex's dependency set differs from minimal: it uses `zod` and does NOT
  // use tailwind (its app.css is a hand-written design system). `react-dom` is
  // included as the framework's SSR/hydration peer (not a direct pokedex
  // import) — do not "tidy" it away.
  const pkg = {
    name: ctx.projectName,
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      dev: 'brustjs dev',
      build: 'brustjs build',
    },
    dependencies: {
      brustjs: ctx.brustSpec,
      react: '^19.2.6',
      'react-dom': '^19.2.6',
      zod: '^4.4.3',
    },
    devDependencies: {
      '@types/bun': 'latest',
      '@types/react': '^19.2.15',
      '@types/react-dom': '^19.2.3',
      typescript: '^6.0.3',
    },
  }
  return [
    { relPath: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { relPath: 'tsconfig.json', content: readMinimalFile('tsconfig.json') },
    { relPath: '.gitignore', content: readMinimalFile('_gitignore') },
  ]
}

/** Read a bundled file from the minimal template, with a friendly error if the
 * install is incomplete (rather than a raw Node ENOENT). */
function readMinimalFile(name: string): string {
  try {
    return readFileSync(join(MINIMAL_DIR, name), 'utf8')
  } catch (e) {
    throw new Error(
      `brust new: cannot read bundled template file "${name}" — installation may be incomplete (${
        e instanceof Error ? e.message : String(e)
      })`,
    )
  }
}

/**
 * Build the template registry fresh per call so a missing/corrupt install
 * surfaces as a thrown error at invocation time (not import time).
 */
export function listTemplates(): TemplateDef[] {
  const root = findBrustPackageRoot()
  return [
    {
      name: 'minimal',
      title: 'minimal',
      description: 'Minimal starter: native route + island counter',
      sourceDir: MINIMAL_DIR,
      exclude: new Set<string>(),
    },
    {
      name: 'pokedex',
      title: 'pokedex',
      description: 'Full PokéDex demo: native routes, loaders, islands, team store',
      sourceDir: join(root, 'example', 'pokedex'),
      // FRAMEWORK-GAPS.md + README.md are internal docs. .brust/dist/node_modules
      // are dev-tree build artifacts that must never be scaffolded.
      exclude: new Set(['FRAMEWORK-GAPS.md', 'README.md', '.brust', 'dist', 'node_modules']),
      extraFiles: pokedexExtraFiles,
    },
  ]
}

export function getTemplate(name: string): TemplateDef | undefined {
  return listTemplates().find((t) => t.name === name)
}
