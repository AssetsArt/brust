import { brust } from '@brust/core/elysia'
import { Elysia, t } from 'elysia'

// The shared source of the typed client: `import type { App } from './actions'`.
const app = new Elysia({ adapter: brust() })
  .get('/hello', () => ({ hello: 'standalone' }))
  .post('/team', { body: t.Object({ name: t.String() }) }, ({ body, set }) => {
    // A cross-site cookie needs SameSite=None; Secure (browsers treat http://127.0.0.1 and localhost as secure contexts).
    set.headers['set-cookie'] = `team=${encodeURIComponent(body.name)}; Path=/; SameSite=None; Secure; HttpOnly`
    return { saved: body.name }
  })
  .get('/team', ({ cookie }) => ({ team: cookie.team?.value ?? null }))
  // F474: the body unread by Elysia; the action reports the framing it saw and the bytes it got.
  .post('/echo', { parse: 'none' }, async ({ request }) => ({
    contentLength: request.headers.get('content-length'),
    bytes: (await request.arrayBuffer()).byteLength,
  }))
  // F475: listed in brust.toml `stream` where a test streams (tests/cf); the body is read chunk by chunk, never whole.
  .post('/upload', { parse: 'none' }, async ({ request }) => {
    let bytes = 0
    const reader = request.body?.getReader()
    if (reader) for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
    }
    return { contentLength: request.headers.get('content-length'), bytes }
  })

export type App = typeof app
export default app
