// F189: `Bun.resolveSync` answers the CJS `main` of a package that has both (recharts: `main` is a CJS build, `module`
// the ES build), so a package resolved from a directory the bundler does not walk (a package's own, for what its source
// imports) became a second, CJS copy beside the ESM one every other island imports. This picks the entry the bundler
// itself would pick: `exports` conditions in the order the package lists them, else `module`; anything it cannot place
// (patterns, missing files) falls back to `Bun.resolveSync`, which is today's answer.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { splitSpecifier } from './pkg-src'

const DEFAULT_CONDITIONS = ['import', 'module', 'default']

/** The first `node_modules/<name>` from `from` upwards, as a real path. */
function packageDir(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return realpathSync(p)
    if (dirname(dir) === dir) return undefined
  }
}

/** A target of `exports` / `module`: a string, or the first listed key whose condition holds (an array: the first that resolves). */
function pick(x: unknown, conditions: readonly string[]): string | undefined {
  if (typeof x === 'string') return x
  if (Array.isArray(x)) {
    for (const e of x) {
      const t = pick(e, conditions)
      if (t !== undefined) return t
    }
    return undefined
  }
  if (!x || typeof x !== 'object') return undefined
  for (const [k, v] of Object.entries(x)) if (conditions.includes(k)) return pick(v, conditions)
  return undefined
}

/** `spec` from `from`, preferring the package's ES entry. */
export function resolveEsm(spec: string, from: string, conditions: readonly string[] = DEFAULT_CONDITIONS): string {
  const [name, sub] = splitSpecifier(spec)
  const dir = packageDir(name, from)
  if (dir !== undefined) {
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: unknown; module?: unknown }
      const key = sub === '' ? '.' : `./${sub}`
      let target: string | undefined
      if (pj.exports === undefined) target = sub === '' && typeof pj.module === 'string' ? pj.module : undefined
      else if (typeof pj.exports === 'string' || Array.isArray(pj.exports) || !Object.keys(pj.exports as object).some((k) => k.startsWith('.')))
        target = key === '.' ? pick(pj.exports, conditions) : undefined
      else target = pick((pj.exports as Record<string, unknown>)[key], conditions)
      // A target that leaves the package (`../x`) is not followed.
      if (target !== undefined && !target.split('/').includes('..')) {
        const file = join(dir, target)
        if (existsSync(file)) return file
      }
    } catch {
      // an unreadable package.json: the runtime resolution decides
    }
  }
  return Bun.resolveSync(spec, from)
}
