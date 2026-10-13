// tests/server/harness.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export const app = join(import.meta.dir, '../../examples/pokedex')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
export type Stats = { l1: { hits: number; misses: number }; job: { hits: number; misses: number }; loader_calls: number; job_calls: number }
/** `db`: a team.sqlite path to reuse (restart tests); otherwise a fresh temp dir the harness owns and removes on stop.
 *  Every server gets POKEDEX_TEAM_DB, so no test ever creates examples/pokedex/data/team.sqlite. */
export async function startPokedex(opts: { build?: boolean; db?: string } = {}) {
  if (opts.build !== false) {
    const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
    if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  }
  const owned = opts.db === undefined ? mkdtempSync(join(tmpdir(), 'pokedex-team-')) : null
  const db = opts.db ?? join(owned as string, 'team.sqlite')
  // `bun test` sets NODE_ENV=test and workers only default it (run.ts: ??=); a real `brust start` is production (422 bodies, error details).
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', POKEDEX_TEAM_DB: db, NODE_ENV: 'production' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  // `[brust] listening on` (Rust) and `[brust] ready` (JS) are printed by two threads that both wake on the workers'
  // registration: either can come first (F128), so wait for both. A boot that dies reports everything it printed.
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before 'listening on' and 'ready' (pid ${proc.pid}); output so far:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  const base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; out += dec.decode(value, { stream: true }) } })()
  return {
    base,
    db,
    action: (path: string, init?: RequestInit) => fetch(`${base}/_brust/action${path}`, init),
    stats: async (): Promise<Stats> => (await fetch(`${base}/_brust/cache/stats`)).json() as Promise<Stats>,
    stop: async () => {
      proc.kill('SIGINT')
      if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
      if (owned) rmSync(owned, { recursive: true, force: true })
    },
  }
}
