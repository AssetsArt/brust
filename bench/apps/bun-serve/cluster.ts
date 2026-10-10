// bench/apps/bun-serve/cluster.ts — N copies of index.ts on one port (Bun.serve reusePort), so bun-serve gets the same
// process budget as brust's `--workers N`. Prints the ready line once every copy listens; stopping this process's
// group (what the runner does) ends the copies too.
//   BENCH_PORT=38302 BENCH_PROCS=10 BENCH_CTRL_BASE=38352 bun bench/apps/bun-serve/cluster.ts
import { join } from 'node:path'

const procs = Math.max(1, Number.parseInt(process.env.BENCH_PROCS ?? '1', 10))
const ctrlBase = Number.parseInt(process.env.BENCH_CTRL_BASE ?? '38352', 10)
const port = process.env.BENCH_PORT ?? '38302'
const children = Array.from({ length: procs }, (_, i) =>
  Bun.spawn(['bun', join(import.meta.dir, 'index.ts')], { env: { ...process.env, BENCH_PORT: port, BENCH_CTRL_PORT: String(ctrlBase + i) }, stdout: 'pipe', stderr: 'inherit' }),
)
await Promise.all(children.map(async (c) => {
  const dec = new TextDecoder()
  let out = ''
  for await (const chunk of c.stdout as ReadableStream<Uint8Array>) {
    out += dec.decode(chunk, { stream: true })
    if (/listening on/.test(out)) return
  }
  throw new Error(`bun-serve copy exited before listening:\n${out}`)
}))
console.log(`[bun-serve] listening on http://127.0.0.1:${port} procs=${procs} ctrl=${ctrlBase}`)
const stop = () => { for (const c of children) c.kill('SIGINT'); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
