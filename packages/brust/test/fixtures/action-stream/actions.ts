import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

// F475: `/upload` reads its streamed body chunk by chunk and answers the byte count and SHA-256; `/rss` reports this
// process's resident set (the Rust server and the workers share it).
const app = new Elysia({ adapter: brust() })
  .post('/upload', { parse: 'none' }, async ({ request }) => {
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
  .get('/rss', () => ({ rss: process.memoryUsage.rss() }))

export default app
