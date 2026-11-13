import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

// F547: buffered action replies the server may gzip. ~19 KB of JS (compressible, long), the same with the app's
// `no-transform` opt-out, one reply too short to compress, one with a type that never compresses, and one the app
// already encoded itself.
const js = Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i} * 2; // module line ${i}\n`).join('')

const app = new Elysia({ adapter: brust() })
  .get('/js', () => new Response(js, { headers: { 'content-type': 'application/javascript; charset=utf-8', etag: '"v1"', vary: 'Origin' } }))
  .get('/js-nt', () => new Response(js, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'private, no-transform' } }))
  .get('/short', () => new Response('const a = 1', { headers: { 'content-type': 'application/javascript' } }))
  .get('/image', () => new Response(js, { headers: { 'content-type': 'image/png' } }))
  .get('/encoded', () => new Response(js, { headers: { 'content-type': 'application/javascript', 'content-encoding': 'identity' } }))

export default app
export type App = typeof app
