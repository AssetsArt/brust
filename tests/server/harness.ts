// tests/server/harness.ts
import { join } from 'node:path'
export const app = join(import.meta.dir, '../../examples/pokedex')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
export type Stats = { l1: { hits: number; misses: number }; job: { hits: number; misses: number }; loader_calls: number; job_calls: number }
export async function startPokedex() {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  const base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; out += dec.decode(value, { stream: true }) } })()
  return {
    base,
    stats: async (): Promise<Stats> => (await fetch(`${base}/_brust/cache/stats`)).json() as Promise<Stats>,
    stop: async () => {
      proc.kill('SIGINT')
      if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
    },
  }
}
