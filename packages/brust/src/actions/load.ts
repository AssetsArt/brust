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
