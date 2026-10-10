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
}
export interface RunningApp { base: string; proc: Subprocess; log(): string; stop(): Promise<void> }

const CHILDREN = new Set<Subprocess>()
let hooked = false
export function killAllOnExit(): void {
  if (hooked) return
  hooked = true
  process.on('exit', () => { for (const c of CHILDREN) c.kill('SIGKILL') })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130))
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

/** True when something already accepts connections on 127.0.0.1:port. We only ever report it: a listener we did not spawn is never killed. */
export async function portInUse(port: number): Promise<boolean> {
  try {
    const l = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
    l.stop(true)
    return false
  } catch {
    return true
  }
}

export async function startApp(spec: Pick<AppSpec, 'id' | 'port' | 'startCmd' | 'ready' | 'cwd'>, opts: { timeoutMs?: number } = {}): Promise<RunningApp> {
  killAllOnExit()
  if (spec.port > 0 && (await portInUse(spec.port)))
    throw new Error(`[${spec.id}] port ${spec.port} is already in use by another process — not starting, and not killing it (find the owner with: lsof -ti tcp:${spec.port})`)
  const { cmd, env, cwd } = spec.startCmd()
  const proc = Bun.spawn(cmd, { cwd: cwd ?? spec.cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'inherit' })
  CHILDREN.add(proc)
  const stop = async () => {
    CHILDREN.delete(proc)
    if (proc.exitCode !== null) return
    proc.kill('SIGINT')
    const r = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
    if (r === 'timeout') { proc.kill('SIGKILL'); await proc.exited }
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
