// bench/apps/next/cluster.mjs — N copies of the Next standalone server on one port (node:cluster; under Bun on Linux the
// workers bind with SO_REUSEPORT), so Next gets the same process budget as the other apps. Prints one ready line when
// every copy listens; stopping this process's group ends the copies.
//   BENCH_NEXT_SERVER=<server.js> BENCH_PROCS=4 PORT=38303 HOSTNAME=127.0.0.1 bun --bun bench/apps/next/cluster.mjs
import cluster from 'node:cluster'

const procs = Math.max(1, Number.parseInt(process.env.BENCH_PROCS ?? '1', 10))
const server = process.env.BENCH_NEXT_SERVER
if (!server) throw new Error('BENCH_NEXT_SERVER is not set')
if (cluster.isPrimary) {
  let up = 0
  const pids = []
  for (let i = 0; i < procs; i++) {
    const w = cluster.fork()
    pids.push(w.process.pid)
    w.on('listening', () => {
      up += 1
      if (up === procs) console.log(`[next] listening on http://${process.env.HOSTNAME}:${process.env.PORT} procs=${procs} pids=${pids.join(',')}`)
    })
    w.on('exit', (code) => {
      if (up < procs) {
        console.error(`[next] a copy exited (${code}) before listening`)
        process.exit(1)
      }
    })
  }
  const stop = () => {
    for (const w of Object.values(cluster.workers ?? {})) w?.kill('SIGINT')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else {
  await import(server)
}
