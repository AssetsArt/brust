// bench/apps/elysia-bun/index.ts — one process of the Elysia-on-Bun comparator for A1/A2: the shared actions app mounted
// under brust's prefix (R7, the exact shape brust's worker builds), served by Elysia's default Bun adapter (`listen`).
// `reusePort: true` lets N copies share the port (see cluster.ts); each reports its served count on a control port.
//   BENCH_PORT=38305 BENCH_CTRL_PORT=38345 NODE_ENV=production bun bench/apps/elysia-bun/index.ts
import { Elysia } from 'elysia'
import { actionsApp, servedCount } from '../_shared/actions-app'

const app = new Elysia({ prefix: '/_brust/action' }).use(actionsApp())
const ctrl = process.env.BENCH_CTRL_PORT
  ? Bun.serve({ hostname: '127.0.0.1', port: Number.parseInt(process.env.BENCH_CTRL_PORT, 10), fetch: () => Response.json({ pid: process.pid, count: servedCount() }) })
  : null
// The ready line is printed in the callback: the Bun adapter gates requests until its build settles.
app.listen({ hostname: '127.0.0.1', port: Number.parseInt(process.env.BENCH_PORT ?? '38305', 10), reusePort: true }, (s) => {
  console.log(`[elysia-bun] listening on http://127.0.0.1:${s.port}`)
})
process.on('SIGINT', () => { void app.stop(true); ctrl?.stop(true); process.exit(0) })
