// F488: on Windows a kill of the `bun run start` wrapper (TerminateProcess; there are no process groups) ends the wrapper and the
// `.bin/brust.exe` shim but not the server below them: it keeps the port, the app dir and the inherited pipes. Probe on windows-latest:
// wrapper `bun.exe` -> shim `brust.exe` -> server `bun.exe`. So the server watches its launchers and drains when one is gone.
// The watched set is the contiguous run of bun-family ancestors (image bun / brust) from the parent upward; it stops at the first other
// image (a shell, an IDE, a process manager) or a missing row (an already dead parent). A server started straight from a shell has no
// bun-family ancestor, so it watches nothing. POSIX never calls this (platform gate in `watchLauncher`).
import { execFile } from 'node:child_process'

export interface ProcRow {
  pid: number
  ppid: number
  name: string
}

/** The images that make up `bun run <script>` -> `.bin/<name>` shim -> server. */
export const isLauncherImage = (name: string): boolean => /^(bun|brust)(\.exe)?$/i.test(name)

/** Pure: the pids of the contiguous bun-family ancestors of `self` (nearest first). */
export function launcherChain(rows: readonly ProcRow[], self: number): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const out: number[] = []
  const seen = new Set([self])
  for (let r = byPid.get(byPid.get(self)?.ppid ?? -1); r && !seen.has(r.pid) && isLauncherImage(r.name); r = byPid.get(r.ppid)) {
    out.push(r.pid)
    seen.add(r.pid)
  }
  return out
}

/** The Windows process table (pid, ppid, image) through Win32_Process. */
export function readProcTable(): Promise<ProcRow[]> {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        const rows = JSON.parse(stdout || '[]') as { ProcessId: number; ParentProcessId: number; Name: string }[]
        resolve(rows.map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name })))
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** `process.kill(pid, 0)` throws ESRCH when the process is gone; EPERM means it exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface LauncherWatchOptions {
  /** Runs once, when a watched launcher is gone. */
  onGone: (pid: number) => void
  platform?: NodeJS.Platform
  self?: number
  readTable?: () => Promise<ProcRow[]>
  alive?: (pid: number) => boolean
  intervalMs?: number
}

/** Windows only: resolve the launcher chain once, then poll it. Resolves with the watched pids (empty: nothing watched, also on POSIX or
 * when the table cannot be read: a failure to watch must never stop a server) and a `stop`. The timer is unref'd: it never holds the process. */
export async function watchLauncher(opts: LauncherWatchOptions): Promise<{ pids: number[]; stop: () => void }> {
  const none = { pids: [] as number[], stop: () => {} }
  if ((opts.platform ?? process.platform) !== 'win32') return none
  let pids: number[]
  try {
    const rows = await (opts.readTable ?? readProcTable)()
    const me = rows.find((r) => r.pid === (opts.self ?? process.pid))
    console.error(`[brust] launcher-watch DEBUG: rows=${rows.length} self=${opts.self ?? process.pid} me=${JSON.stringify(me)} parent=${JSON.stringify(rows.find((r) => r.pid === me?.ppid))}`)
    console.error(`[brust] launcher-watch DEBUG: family=${JSON.stringify(rows.filter((r) => /bun|brust|cmd|node|bash|pwsh|powershell/i.test(r.name)).map((r) => [r.pid, r.ppid, r.name]))}`)
    pids = launcherChain(rows, opts.self ?? process.pid)
  } catch (e) {
    console.error(`[brust] launcher-watch DEBUG: table unreadable: ${String(e)}`)
    return none
  }
  console.error(`[brust] launcher-watch DEBUG: chain=${JSON.stringify(pids)}`)
  if (pids.length === 0) return none
  const alive = opts.alive ?? pidAlive
  const timer = setInterval(() => {
    console.error(`[brust] launcher-watch DEBUG: alive=${JSON.stringify(pids.map((p) => alive(p)))}`)
    const gone = pids.find((p) => !alive(p))
    if (gone === undefined) return
    clearInterval(timer)
    opts.onGone(gone)
  }, opts.intervalMs ?? 1000)
  timer.unref()
  return { pids, stop: () => clearInterval(timer) }
}
