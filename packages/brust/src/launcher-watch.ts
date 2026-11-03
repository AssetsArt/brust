// F488: on Windows a kill of the `bun run start` wrapper (TerminateProcess; no process groups) takes the `.bin/brust.exe` shim down with it
// but not the server below: it keeps the port, the app dir and the inherited pipes. Probe on windows-latest (PR #428): wrapper -> shim ->
// server, and after a plain wrapper kill the shim is gone while the server lives. The shim is the server's direct parent, so the server
// watches `process.ppid`: when that dies it drains like Ctrl+C. Started at boot, synchronously: no process table, nothing awaited.
// (A PowerShell table read awaited before `ready` cost seconds per start and broke 5 s static builds; the lead ruled it out.)
// POSIX never watches (platform gate): a POSIX supervisor signals the server directly.

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
  /** Runs once, when the parent is gone. */
  onGone: (pid: number) => void
  platform?: NodeJS.Platform
  ppid?: number
  alive?: (pid: number) => boolean
  intervalMs?: number
  log?: (line: string) => void
}

/** Windows only. Returns the watched pid (undefined: nothing watched) and a `stop`. The timer is unref'd: it never holds the process open. */
export function watchLauncher(opts: LauncherWatchOptions): { pid: number | undefined; stop: () => void } {
  const none = { pid: undefined, stop: () => {} }
  if ((opts.platform ?? process.platform) !== 'win32') return none
  const ppid = opts.ppid ?? process.ppid
  const alive = opts.alive ?? pidAlive
  if (!ppid || !alive(ppid)) {
    ;(opts.log ?? console.error)(`[brust] launcher (pid ${ppid}) is already gone at boot: not watching it`)
    return none
  }
  const timer = setInterval(() => {
    if (alive(ppid)) return
    clearInterval(timer)
    opts.onGone(ppid)
  }, opts.intervalMs ?? 1000)
  timer.unref()
  return { pid: ppid, stop: () => clearInterval(timer) }
}
