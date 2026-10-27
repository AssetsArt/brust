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
