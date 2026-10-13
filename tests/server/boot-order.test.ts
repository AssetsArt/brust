// F128: `[brust] listening on` (printed by the Rust server thread) must come BEFORE `[brust] ready` (printed by run.ts after
// `untilReady`), because ~35 callers read the address from the log once they saw `ready`. Both threads wake on the same worker
// registrations, so the order used to be a race (3 of 120 boots printed `ready` first with 16 boots at once). `untilReady`
// now also waits for the server's own announcement. Many concurrent boots make the old race show; the log is in every failure.
import { expect, test } from 'bun:test'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../examples/pokedex')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')

async function boot(): Promise<{ log: string; listeningFirst: boolean }> {
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'ignore' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  try {
    while (!/\[brust\] ready/.test(log)) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`brust start exited before ready (pid ${proc.pid}); output so far:\n${log}`)
      log += dec.decode(value, { stream: true })
    }
    // the bytes of one write can arrive split: look at everything that came with `ready`
    return { log, listeningFirst: log.indexOf('listening on') >= 0 && log.indexOf('listening on') < log.indexOf('[brust] ready') }
  } finally {
    proc.kill('SIGINT')
    await Promise.race([proc.exited, Bun.sleep(5000).then(() => proc.kill('SIGKILL'))])
  }
}

test('`listening on` is printed before `ready` on every boot (16 at once, 3 rounds)', async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  for (let round = 0; round < 3; round++) {
    const boots = await Promise.all(Array.from({ length: 16 }, boot))
    const bad = boots.filter((x) => !x.listeningFirst)
    expect(bad.map((x) => x.log)).toEqual([])
  }
}, 120_000)
