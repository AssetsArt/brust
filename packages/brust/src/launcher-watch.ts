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

/** F492 (PID reuse): the identity of a process that outlives a PID: its creation time (a FILETIME, 100 ns ticks since 1601), read once
 * through kernel32 `GetProcessTimes` (`OpenProcess` with the query-limited right: no elevation, no process table, no PowerShell). A PID
 * that is reused by another process has another creation time. `undefined` when it cannot be read (not Windows, the process is gone, no
 * access, `bun:ffi` missing): the watch then keeps its pid-only behaviour. Synchronous, a few microseconds, nothing awaited. */
export function processIdentity(pid: number): string | undefined {
  if (process.platform !== 'win32') return undefined
  const k = kernel32()
  if (!k) return undefined
  try {
    const h = k.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid)
    if (!h) return undefined
    try {
      const t = new BigUint64Array(4) // creation, exit, kernel, user
      const base = k.ptr(t)
      if (!k.GetProcessTimes(h, base, k.ptr(t, 8), k.ptr(t, 16), k.ptr(t, 24))) return undefined
      return t[0]!.toString()
    } finally {
      k.CloseHandle(h)
    }
  } catch {
    return undefined
  }
}

type Kernel32 = {
  OpenProcess(access: number, inherit: number, pid: number): unknown
  GetProcessTimes(h: unknown, a: unknown, b: unknown, c: unknown, d: unknown): number
  CloseHandle(h: unknown): number
  ptr: (view: ArrayBufferView, offset?: number) => never
}
let k32: Kernel32 | null | undefined
/** The three kernel32 bindings, opened ONCE for the life of the process: `dlopen` compiles a binding per symbol and holds it until
 * the library is closed, and the watch reads the identity every tick of a long-running server. `null` = unavailable (kept). */
function kernel32(): Kernel32 | null {
  if (k32 !== undefined) return k32
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const s = dlopen('kernel32.dll', {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
    k32 = { ...(s as unknown as Omit<Kernel32, 'ptr'>), ptr: ptr as Kernel32['ptr'] }
  } catch {
    k32 = null
  }
  return k32
}

export interface LauncherWatchOptions {
  /** Runs once, when the parent is gone. */
  onGone: (pid: number) => void
  platform?: NodeJS.Platform
  ppid?: number
  alive?: (pid: number) => boolean
  /** The parent's identity (default: its creation time, win32). Read once at boot and again on each tick while the pid answers alive: a different value means the pid was reused, so the launcher is gone. */
  identity?: (pid: number) => string | undefined
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
  const identity = opts.identity ?? processIdentity
  const born = identity(ppid)
  const timer = setInterval(() => {
    if (alive(ppid) && (born === undefined || identity(ppid) === born)) return
    clearInterval(timer)
    opts.onGone(ppid)
  }, opts.intervalMs ?? 1000)
  timer.unref()
  return { pid: ppid, stop: () => clearInterval(timer) }
}
