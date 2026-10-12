// Shared helpers of the pokedex-on-D1 e2e: spawn a pinned `wrangler dev` (lane 3's R6 flag set), migrate a local D1, and a
// TeamDb proxy that talks to the harness Worker.
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import type { AddResult, TeamDb } from '../../../examples/pokedex/lib/team-db'
import type { TeamMember } from '../../../examples/pokedex/lib/types'
import { WRANGLER } from '../tools'

export const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }

export const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

/** `wrangler d1 migrations apply TEAM_DB --local --persist-to <state> -c <config>`; throws on a non-zero exit. */
export function migrateLocal(config: string, state: string): void {
  const r = Bun.spawnSync(['bunx', WRANGLER, 'd1', 'migrations', 'apply', 'TEAM_DB', '--local', '--persist-to', state, '-c', config], { cwd: dirname(config), env: ENV })
  if (r.exitCode !== 0) throw new Error(`d1 migrations apply exited ${r.exitCode}:\n${r.stdout.toString()}${r.stderr.toString()}`)
}

export interface Wrangler {
  base: string
  log: () => string
  stop(): Promise<void>
}

/** Spawns `wrangler dev -c <config> --persist-to <state>` and resolves once it prints `Ready on`. */
export async function startWrangler(o: { config: string; state: string }): Promise<Wrangler> {
  const [port, inspector] = [await freePort(), await freePort()]
  const dev = Bun.spawn(
    ['bunx', WRANGLER, 'dev', '-c', o.config, '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspector), '--persist-to', o.state, '--show-interactive-dev-session=false'],
    { cwd: dirname(o.config), env: ENV, stdout: 'pipe', stderr: 'pipe' },
  )
  let log = ''
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const d = new TextDecoder()
    for await (const chunk of s) log += d.decode(chunk)
  }
  void pump(dev.stdout as ReadableStream<Uint8Array>)
  void pump(dev.stderr as ReadableStream<Uint8Array>)
  const deadline = Date.now() + 120_000
  while (!/Ready on (http:\/\/\S+)/.test(log)) {
    if (Date.now() > deadline || dev.exitCode !== null) {
      dev.kill('SIGKILL')
      throw new Error(`wrangler dev not ready:\n${log}`)
    }
    await Bun.sleep(250)
  }
  return {
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    async stop() {
      dev.kill('SIGINT')
      const ok = await Promise.race([dev.exited.then(() => true), Bun.sleep(5000).then(() => false)])
      if (!ok) dev.kill('SIGKILL')
      await dev.exited
    },
  }
}

/** The harness Worker as a TeamDb. */
export function remoteTeamDb(base: string): TeamDb {
  const call = async <T>(op: string, ...args: unknown[]): Promise<T> => {
    const r = await fetch(`${base}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) })
    if (!r.ok) throw new Error(`harness ${op} -> ${r.status}: ${await r.text()}`)
    return (await r.json()) as T
  }
  return {
    list: () => call<TeamMember[]>('list'),
    add: (m) => call<AddResult>('add', m),
    remove: (id) => call<boolean>('remove', id),
  }
}

export const resetRemote = async (base: string): Promise<void> => {
  const r = await fetch(`${base}/reset`, { method: 'POST' })
  if (!r.ok) throw new Error(`harness reset -> ${r.status}`)
}
