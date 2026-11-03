// Resolves the `@brust/core` spec written into a scaffolded package.json (`__BRUST_DEP__`, M3-F rulings R2/R3).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** = scripts/release-files.ts PLATS. */
export const PLATS = ['darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl', 'win32-x64-msvc'] as const

export interface BrustDep {
  kind: 'explicit' | 'version' | 'workspace' | 'file'
  spec: string
  overrides?: Record<string, string>
}

export const packageRoot = (): string => resolve(import.meta.dir, '..')

const readJson = (p: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> } catch { return null }
}

/** The brust checkout this package lives in, or null. Exact markers two levels up, no walking: a bunx cache can never match. */
export function monorepoRoot(pkgRoot = packageRoot()): string | null {
  const root = resolve(pkgRoot, '../..')
  const rootPkg = readJson(join(root, 'package.json'))
  if (rootPkg?.name !== 'brust-v2' || !Array.isArray(rootPkg.workspaces)) return null
  if (readJson(join(root, 'packages/brust/package.json'))?.name !== '@brust/core') return null
  if (!existsSync(join(root, 'examples/pokedex/routes.tsx'))) return null
  return root
}

/** `x/*` matches a direct child of `<root>/x`; a literal `x` matches `<root>/x` itself. */
function inWorkspace(root: string, target: string): boolean {
  const rootPkg = readJson(join(root, 'package.json'))
  const globs = (rootPkg?.workspaces as string[] | undefined) ?? []
  const rel = fileSpecPath(relative(root, resolve(target)))
  if (rel.startsWith('..') || rel === '') return false
  return globs.some((g) => (g.endsWith('/*') ? dirname(rel) === g.slice(0, -2) : rel === g))
}

/** F484: a `file:` spec path is `/`-spelled on every platform (`C:\\repo` -> `C:/repo`); a no-op on POSIX. */
export function fileSpecPath(p: string, s: string = sep): string {
  return s === '/' ? p : p.split(s).join('/')
}

export function resolveBrustDep(o: { explicit?: string; targetDir: string; pkgRoot?: string }): BrustDep {
  if (o.explicit) return { kind: 'explicit', spec: o.explicit }
  const pkgRoot = o.pkgRoot ?? packageRoot()
  const root = monorepoRoot(pkgRoot)
  if (root) {
    if (inWorkspace(root, o.targetDir)) return { kind: 'workspace', spec: 'workspace:*' }
    // `file:` alone fails: core's own workspace:* deps do not resolve outside the workspace globs, so override them.
    const r = fileSpecPath(root)
    const overrides: Record<string, string> = { '@brust/runtime-dom': `file:${r}/packages/runtime-dom` }
    overrides['@brust/core-cf'] = `file:${r}/npm/core-cf`
    for (const p of PLATS) overrides[`@brust/native-${p}`] = `file:${r}/npm/${p}`
    return { kind: 'file', spec: `file:${r}/packages/brust`, overrides }
  }
  const version = (readJson(join(pkgRoot, 'package.json'))?.version as string | undefined) ?? '0.0.0'
  return { kind: 'version', spec: `^${version}` }
}

/** Merge `overrides` into <appDir>/package.json (2-space JSON + trailing newline). */
export function applyOverrides(appDir: string, overrides: Record<string, string>): void {
  const p = join(appDir, 'package.json')
  const pkg = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  pkg.overrides = { ...(pkg.overrides as Record<string, string> | undefined), ...overrides }
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`)
}
