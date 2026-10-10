// bench/lib/app.ts — one running app: spawn, wait for its ready line (port scraped from stdout), stop.
// Every child is tracked and killed on runner exit so a failed start never orphans a server.
import type { Subprocess } from 'bun'
import type { ProbeId } from './probes'

export type AppId = 'brust' | 'bun-serve' | 'next' | 'brust-01x'
export interface AppSpec {
  id: AppId
  label: string
  cwd: string
  port: number
  available(): { ok: true } | { ok: false; reason: string }
  build(log: (s: string) => void): Promise<void>
  startCmd(): { cmd: string[]; env: Record<string, string>; cwd?: string }
  ready: RegExp
  version(): Promise<string>
  sanity?(base: string, probe: ProbeId): Promise<void>
  /** bun-serve only: per-process request counts (to verify reusePort balanced the load). */
  distribution?(): Promise<number[]>
}
export interface RunningApp { base: string; proc: Subprocess; log(): string; stop(): Promise<void> }

const CHILDREN = new Set<Subprocess>()
/** Signal the process group we created for `proc` (pgid = its pid). Never anything else: the pid comes from our own spawn. */
function signalGroup(proc: Subprocess, sig: NodeJS.Signals): void {
  try { process.kill(-proc.pid, sig) } catch { /* group already gone */ }
}
let hooked = false
export function killAllOnExit(): void {
  if (hooked) return
  hooked = true
  process.on('exit', () => { for (const c of CHILDREN) signalGroup(c, 'SIGKILL') })
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
}

export async function waitForLine(stdout: ReadableStream<Uint8Array>, re: RegExp, timeoutMs: number, onExit: Promise<number>): Promise<{ match: RegExpExecArray; log: () => string }> {
  const reader = stdout.getReader()
  const dec = new TextDecoder()
  let out = ''
  const log = () => out
  const drain = async () => { for (;;) { const r = await reader.read(); if (r.done) return; out += dec.decode(r.value, { stream: true }) } }
  const found = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`exited (${await onExit}) before ready:\n${out}`)
      out += dec.decode(value, { stream: true })
      const m = re.exec(out)
      if (m) { void drain(); return m }
    }
  })()
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`not ready after ${timeoutMs} ms:\n${out}`)), timeoutMs))
  const exited = onExit.then((code) => { throw new Error(`exited (${code}) before ready:\n${out}`) })
  const match = await Promise.race([found, timer, exited])
  return { match, log }
}

/** True when something already listens on `port` (any interface). We only ever report it: a listener we did not spawn is never killed. */
export async function portInUse(port: number): Promise<boolean> {
  for (const hostname of ['127.0.0.1', '0.0.0.0']) {
    try {
      Bun.listen({ hostname, port, socket: { data() {} } }).stop(true)
    } catch {
      return true
    }
  }
  return false
}

export async function startApp(spec: Pick<AppSpec, 'id' | 'port' | 'startCmd' | 'ready' | 'cwd'>, opts: { timeoutMs?: number } = {}): Promise<RunningApp> {
  killAllOnExit()
  if (spec.port > 0 && (await portInUse(spec.port)))
    throw new Error(`[${spec.id}] port ${spec.port} is already in use by another process — not starting, and not killing it (find the owner with: lsof -ti tcp:${spec.port})`)
  const { cmd, env, cwd } = spec.startCmd()
  // detached = own process group, so stop() can end the child AND anything it spawned (and nothing else).
  const proc = Bun.spawn(cmd, { cwd: cwd ?? spec.cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'inherit', detached: true })
  CHILDREN.add(proc)
  const stop = async () => {
    CHILDREN.delete(proc)
    signalGroup(proc, 'SIGINT')
    const r = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
    if (r === 'timeout') { signalGroup(proc, 'SIGKILL'); await proc.exited }
    signalGroup(proc, 'SIGKILL') // grandchildren that outlived the leader
  }
  let match: RegExpExecArray
  let log: () => string
  try {
    ;({ match, log } = await waitForLine(proc.stdout as ReadableStream<Uint8Array>, spec.ready, opts.timeoutMs ?? 60_000, proc.exited))
  } catch (e) {
    await stop()
    throw new Error(`[${spec.id}] ${(e as Error).message}`)
  }
  const port = match[1] !== undefined ? Number.parseInt(match[1], 10) : spec.port
  return { base: `http://127.0.0.1:${port}`, proc, log, stop }
}
