// `brust build --target static` planner (gaps round L9, R9.2-R9.3): which paths to render and the
// file each one is written to. Pure: no server, no filesystem. `params()` results come in resolved.
import type { FlatRoute, RouteSsgConfig } from '../routes'
import { BuildError } from './errors'

/** The path the `*` route is rendered at: no route matches it, so the server answers the 404 page. */
export const NOT_FOUND_PATH = '/__brust_ssg_not_found__'

export interface PlannedPage {
  /** The request path (each `{name}` value percent-encoded). */
  path: string
  /** Relative to the static dir: `index.html`, `docs.html`, `docs/x.html`, `404.html`. */
  file: string
  routeId: string
  pattern: string
  /** 200, or 404 for the `*` route. */
  expect: 200 | 404
}

export interface StaticPlan {
  pages: PlannedPage[]
  /** Routes `ssg: false` left out (listed in the report). */
  skipped: { routeId: string; pattern: string }[]
  /** No `*` route: the build writes a default 404.html. */
  defaultNotFound: boolean
}

/** A leaf's own `ssg` field (the last node of its chain). */
export function ssgOf(leaf: FlatRoute): RouteSsgConfig | undefined {
  return leaf.chain[leaf.chain.length - 1]?.ssg
}

const SEGMENT = /\{(\*?)([^}]*)\}/g

/** The `{name}` / `{*name}` segment names of a pattern, in order. */
export function patternParams(pattern: string): { name: string; rest: boolean }[] {
  return [...pattern.matchAll(SEGMENT)].map((m) => ({ name: m[2]!, rest: m[1] === '*' }))
}

/** The file a request path is written to: `/` → `index.html`, `/a/b` → `a/b.html` (decoded, so a
 * host that decodes the URL finds it). */
export function fileFor(path: string): string {
  if (path === '/') return 'index.html'
  const decoded = path
    .slice(1)
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/')
  return `${decoded}.html`
}

/** One `{name}` value: a non-empty string; `/` only in a `{*rest}` value, and never an empty, `.`
 * or `..` segment (the file name would leave its directory). */
function checkValue(leaf: FlatRoute, i: number, name: string, rest: boolean, v: unknown): string {
  const where = `route ${leaf.id} (${leaf.pattern}) ssg.params()[${i}].${name}`
  if (typeof v !== 'string' || v === '') throw new BuildError('ssg-params', `${where} is ${v === '' ? 'empty' : 'missing'}: every {${name}} needs a non-empty string`)
  if (!rest && v.includes('/')) throw new BuildError('ssg-params', `${where} = ${JSON.stringify(v)} contains '/': a {${name}} value is one path segment`)
  for (const seg of v.split('/'))
    if (seg === '' || seg === '.' || seg === '..') throw new BuildError('ssg-params', `${where} = ${JSON.stringify(v)} has an empty, '.' or '..' segment`)
  return v
}

/** Plans every page. `params` holds each dynamic route's resolved `ssg.params()` by route id. */
export function planStatic(leaves: FlatRoute[], params: Map<string, unknown>): StaticPlan {
  const pages: PlannedPage[] = []
  const skipped: StaticPlan['skipped'] = []
  let catchAll: FlatRoute | undefined
  for (const leaf of leaves) {
    const ssg = ssgOf(leaf)
    if (ssg === false) {
      skipped.push({ routeId: leaf.id, pattern: leaf.pattern })
      continue
    }
    if (leaf.catchAll) {
      catchAll = leaf
      continue
    }
    const names = patternParams(leaf.pattern)
    if (names.length === 0) {
      pages.push({ path: leaf.pattern, file: fileFor(leaf.pattern), routeId: leaf.id, pattern: leaf.pattern, expect: 200 })
      continue
    }
    if (!ssg || ssg.params === undefined)
      throw new BuildError(
        'ssg-params-missing',
        `route ${leaf.id} (${leaf.pattern}) is dynamic: add ssg: { params: () => [{ ${names.map((n) => `${n.name}: '…'`).join(', ')} }] } or ssg: false`,
      )
    const recs = params.get(leaf.id)
    if (!Array.isArray(recs)) throw new BuildError('ssg-params', `route ${leaf.id} (${leaf.pattern}) ssg.params() must return an array of records`)
    recs.forEach((rec, i) => {
      if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) throw new BuildError('ssg-params', `route ${leaf.id} (${leaf.pattern}) ssg.params()[${i}] is not a record`)
      const r = rec as Record<string, unknown>
      let k = 0
      const path = leaf.pattern.replace(SEGMENT, () => {
        const { name, rest } = names[k++]!
        const v = checkValue(leaf, i, name, rest, r[name])
        return v.split('/').map(encodeURIComponent).join('/')
      })
      pages.push({ path, file: fileFor(path), routeId: leaf.id, pattern: leaf.pattern, expect: 200 })
    })
  }
  const seen = new Map<string, PlannedPage>()
  for (const p of pages) {
    const prev = seen.get(p.file)
    if (prev) throw new BuildError('ssg-params', `${prev.path} (route ${prev.routeId}) and ${p.path} (route ${p.routeId}) both write ${p.file}`)
    seen.set(p.file, p)
  }
  if (seen.has('404.html')) throw new BuildError('ssg-params', `${seen.get('404.html')!.path} would overwrite 404.html`)
  if (catchAll) pages.push({ path: NOT_FOUND_PATH, file: '404.html', routeId: catchAll.id, pattern: catchAll.pattern, expect: 404 })
  return { pages, skipped, defaultNotFound: catchAll === undefined }
}

/** The output paths `ssg.params()` must be resolved for: dynamic leaves with `ssg.params`. */
export function paramRoutes(leaves: FlatRoute[]): FlatRoute[] {
  return leaves.filter((l) => {
    const ssg = ssgOf(l)
    return !l.catchAll && ssg && ssg.params !== undefined && patternParams(l.pattern).length > 0
  })
}
