// bench/lib/cpu.ts — F595 D3/D5: CPU time of processes from /proc (Linux), to measure how evenly the copies of a multi-process app worked. Elsewhere every reader answers null ("not measured").
import { readdirSync, readFileSync } from 'node:fs'

const TICK = (() => {
  const r = process.platform === 'linux' ? Bun.spawnSync(['getconf', 'CLK_TCK'], { stdout: 'pipe', stderr: 'pipe' }) : null
  const n = r && r.exitCode === 0 ? Number.parseInt(r.stdout.toString(), 10) : 100
  return Number.isInteger(n) && n > 0 ? n : 100
})()

/** `/proc/<pid>/stat` → { pgrp, cpu seconds (utime + stime) }. The comm field may hold spaces: split after its `)`. */
export function parseStat(text: string, tick = TICK): { pgrp: number; cpu: number; ppid: number } | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const f = text.slice(close + 2).split(' ')
  // after comm: state(0) ppid(1) pgrp(2) session(3) tty(4) tpgid(5) flags(6) minflt(7) cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12)
  const ppid = Number.parseInt(f[1] ?? '', 10)
  const pgrp = Number.parseInt(f[2] ?? '', 10)
  const ut = Number.parseInt(f[11] ?? '', 10)
  const st = Number.parseInt(f[12] ?? '', 10)
  if (![ppid, pgrp, ut, st].every(Number.isFinite)) return null
  return { pgrp, ppid, cpu: (ut + st) / tick }
}

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** pid → CPU seconds of every process in the process group `pgrp` (the group the runner created for an app). */
export function groupCpu(pgrp: number): Map<number, number> | null {
  if (process.platform !== 'linux') return null
  const out = new Map<number, number>()
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    const t = read(`/proc/${d}/stat`)
    const s = t ? parseStat(t) : null
    if (s && s.pgrp === pgrp) out.set(Number(d), s.cpu)
  }
  return out
}

/** CPU seconds each process spent between two snapshots (processes present in both). */
export function cpuDelta(before: Map<number, number>, after: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>()
  for (const [pid, a] of after) {
    const b = before.get(pid)
    if (b !== undefined) out.set(pid, a - b)
  }
  return out
}

/** Busy share of the whole host over `ms` from /proc/stat (0..1), or null off Linux. */
export async function hostBusy(ms: number): Promise<number | null> {
  if (process.platform !== 'linux') return null
  const snap = () => {
    const l = (read('/proc/stat') ?? '').split('\n')[0]?.trim().split(/\s+/).slice(1).map(Number) ?? []
    const idle = (l[3] ?? 0) + (l[4] ?? 0)
    const total = l.reduce((a, b) => a + b, 0)
    return { idle, total }
  }
  const a = snap()
  await Bun.sleep(ms)
  const b = snap()
  const dt = b.total - a.total
  return dt <= 0 ? null : 1 - (b.idle - a.idle) / dt
}
