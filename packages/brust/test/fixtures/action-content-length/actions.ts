import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

// F474: what the action sees of the client's framing. `parse: 'none'` leaves the body unread by Elysia; the action
// reads it itself and reports the header it saw and the bytes it got.
const app = new Elysia({ adapter: brust() })
  .post('/echo', { parse: 'none' }, async ({ request }) => {
    const bytes = (await request.arrayBuffer()).byteLength
    return {
      contentLength: request.headers.get('content-length'),
      transferEncoding: request.headers.get('transfer-encoding'),
      bytes,
    }
  })
  .put('/echo', { parse: 'none' }, async ({ request }) => ({
    contentLength: request.headers.get('content-length'),
    transferEncoding: request.headers.get('transfer-encoding'),
    bytes: (await request.arrayBuffer()).byteLength,
  }))
  .post('/json', ({ request, body }) => ({ contentLength: request.headers.get('content-length'), body }))

export default app
export type App = typeof app
