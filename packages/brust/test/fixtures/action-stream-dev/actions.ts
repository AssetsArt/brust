import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

// F475 lane B: `/upload` reads its streamed body chunk by chunk and answers the byte count and SHA-256.
const app = new Elysia({ adapter: brust() }).post('/upload', { parse: 'none' }, async ({ request }) => {
  const h = new Bun.CryptoHasher('sha256')
  let bytes = 0
  const r = (request.body as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    bytes += value.length
    h.update(value)
  }
  return { bytes, sha256: h.digest('hex') }
})

export default app
export type App = typeof app
