// Worker side (imports elysia at runtime).
import { type AnyElysia, Elysia } from 'elysia'
import { brust, isBrustAdapter } from './elysia'

/** R3: the user's app mounted under `prefix`, so it answers A1's `url` (path+query, prefix included) as sent. */
export function mountActions(app: unknown, prefix: string, what = 'actions entry'): AnyElysia {
  if (app === undefined)
    throw new Error(`${what}: no default export (export default new Elysia({ adapter: brust() }) …)`)
  if (!(app instanceof Elysia))
    throw new Error(
      `${what}: the default export is not an Elysia app (got ${typeof app}); if it is, two copies of elysia are installed (bun pm ls elysia)`,
    )
  if (!isBrustAdapter(app['~config']?.adapter))
    throw new Error(
      `${what}: build the app with new Elysia({ adapter: brust() }) — import { brust } from '@brust/core/elysia'`,
    )
  // L16 R16.4: the root prefix of an actions-only build is no prefix at all (`prefix: '/'` would double the slash).
  return new Elysia({ adapter: brust(), ...(prefix === '/' ? {} : { prefix }) }).use(app)
}

export async function loadActionsApp(file: string, prefix: string): Promise<AnyElysia> {
  return mountActions((await import(file)).default, prefix, file)
}

/** One path segment of each side matches the other: equal, or either is a parameter (`:x`, `{x}`, `*`). */
const segMatch = (a: string, b: string) => a === b || /^(:|\{|\*)/.test(a) || /^(:|\{|\*)/.test(b)

/**
 * F470: the GET actions a page or loader route under the prefix shadows (a GET there is the route's), as
 * `GET <action path> (route <pattern>)`. Best effort, for a boot warning: segments compared, a parameter matches any.
 */
export function shadowedGetActions(app: AnyElysia, patterns: string[], prefix: string): string[] {
  const under = patterns.filter((p) => p.startsWith(`${prefix}/`))
  const out: string[] = []
  for (const r of app.routes) {
    if (r.method !== 'GET') continue
    const a = r.path.split('/')
    const hit = under.find((p) => {
      const b = p.split('/')
      return a.length === b.length && a.every((s, i) => segMatch(s, b[i]!))
    })
    if (hit) out.push(`GET ${r.path} (route ${hit})`)
  }
  return out
}

/** F475: the route parses nothing (`{ parse: 'none' }`): Elysia 2 keeps `'none'`, Elysia 1 kept `[{ fn: 'none' }]`. */
function parsesNone(r: { hooks?: unknown }): boolean {
  const p = (r.hooks as { parse?: unknown } | undefined)?.parse
  const none = (x: unknown) => x === 'none' || (x as { fn?: unknown } | null)?.fn === 'none'
  return Array.isArray(p) ? p.some(none) : none(p)
}

/** Same route path: segments equal, a parameter (`:x`, `{x}`) matches a parameter, `*` matches `*`. */
function samePath(a: string, b: string): boolean {
  const x = a.split('/')
  const y = b.split('/')
  const param = (s: string) => /^(:|\{)/.test(s)
  return x.length === y.length && x.every((s, i) => s === y[i] || (param(s) && param(y[i]!)))
}

const STREAM_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/**
 * F475: `[actions] stream` against the app. `missing`: listed entries with no `{ parse: 'none' }` route of that method and
 * path (boot fails: Rust would hand those routes a body the app parses as a whole). `unlisted`: `{ parse: 'none' }`
 * POST/PUT/PATCH routes not on the list (their bodies stay buffered, capped at `max_body_bytes`).
 */
export function streamRouteCheck(app: AnyElysia, entries: string[], prefix: string): { missing: string[]; unlisted: string[] } {
  const full = (p: string) => (prefix === '/' ? p : p === '/' ? prefix : prefix + p)
  const listed = entries.map((e) => {
    const [m, p] = e.trim().split(/ +/)
    return { entry: e, method: m!.toUpperCase(), path: full(p!) }
  })
  const routes = app.routes.map((r) => ({ method: r.method.toUpperCase(), path: r.path, none: parsesNone(r) }))
  const missing = listed.filter((l) => !routes.some((r) => r.none && r.method === l.method && samePath(r.path, l.path))).map((l) => l.entry)
  const unlisted = routes
    .filter((r) => r.none && STREAM_METHODS.has(r.method) && !listed.some((l) => l.method === r.method && samePath(r.path, l.path)))
    .map((r) => `${r.method} ${r.path}`)
  return { missing, unlisted }
}
