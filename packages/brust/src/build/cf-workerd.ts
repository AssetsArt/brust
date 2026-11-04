// F482: the newest `compatibility_date` the app's installed workerd runs. `wrangler dev` (and so `brust dev --target
// cloudflare`) refuses a date newer than that, while the default date is the @brust/core-cf build date, which can be newer.
// workerd's npm package carries its own answer: `lib/main.js` exports `compatibilityDate` (the date part of its version,
// `1.YYYYMMDD.n`). Read statically (the package is never imported).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface WorkerdDate {
  /** `YYYY-MM-DD`: the newest compatibility date this workerd supports. */
  date: string
  version: string
  /** The package directory it was read from. */
  dir: string
}

/** The directory of package `name` as Node resolves it from `from`: the nearest `node_modules/<name>` up the tree
 * (package managers that nest, like pnpm, keep a package's own dependencies beside its real directory). */
function findPackage(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return realpathSync(p)
    if (dirname(dir) === dir) return null
  }
}

const readJson = (file: string): { version?: unknown } | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
  } catch {
    return null
  }
}

/** The compatibility date of the workerd in package directory `dir`, or null when it cannot be told. */
function dateOf(dir: string): WorkerdDate | null {
  const version = String(readJson(join(dir, 'package.json'))?.version ?? '')
  let main = ''
  try {
    const f = join(dir, 'lib', 'main.js')
    if (statSync(f).isFile()) main = readFileSync(f, 'utf8')
  } catch {}
  const exported = /\bcompatibilityDate\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(main)?.[1]
  const v = /^1\.(\d{4})(\d{2})(\d{2})\./.exec(version)
  const date = exported ?? (v ? `${v[1]}-${v[2]}-${v[3]}` : undefined)
  return date ? { date, version, dir } : null
}

/** The workerd the app's wrangler runs: wrangler → miniflare → workerd, each resolved from the real directory of the one
 * before it (so a nested install is the right copy); else a `workerd` the app resolves itself; else null. */
export function installedWorkerd(appRoot: string): WorkerdDate | null {
  let from = appRoot
  for (const name of ['wrangler', 'miniflare']) {
    const dir = findPackage(name, from)
    if (!dir) {
      from = ''
      break
    }
    from = dir
  }
  const viaWrangler = from ? findPackage('workerd', from) : null
  const dir = viaWrangler ?? findPackage('workerd', appRoot)
  return dir ? dateOf(dir) : null
}
