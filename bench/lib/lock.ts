// bench/lib/lock.ts — the host-wide measurement lock (lead rule bench-host-lock), two layers:
//  1. an exclusive lock FILE (/tmp/brust-bench.lock, O_EXCL create, holder pid inside) — always on, no env needed;
//  2. the blackboard key `bench:host-lock` = '<slug> <agent> <ISO time>' when BENCH_LOCK_WS + BENCH_LOCK_ID are set,
//     read fail-CLOSED (an unreadable key counts as held), set-then-verify, deleted only if still ours.
// Held for at most 20 minutes: a waiter gives up after that, a lock older than that is stale, and the holder itself
// exits 1 when its own hold exceeds it.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

export const LOCK_KEY = 'bench:host-lock'
export const LOCK_FILE = process.env.BENCH_LOCK_FILE ?? '/tmp/brust-bench.lock'
export const MAX_HOLD_MS = 20 * 60_000

export interface LockValue { owner: string; at: string }
/** `<slug> <agent> <ISO>` → parts; null when the value does not look like a lock. */
export function parseLock(v: string | null): LockValue | null {
  const m = v ? /^(\S+ \S+) (\d{4}-\d{2}-\d{2}T\S+)$/.exec(v.trim()) : null
  return m ? { owner: m[1]!, at: m[2]! } : null
}
/** A lock older than MAX_HOLD_MS is stale (its holder died or overran). */
export function isStale(l: LockValue, now = Date.now()): boolean {
  const t = Date.parse(l.at)
  return Number.isNaN(t) || now - t > MAX_HOLD_MS
}

// ---- layer 1: exclusive lock file --------------------------------------------------------------------------------
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

export type FileLock = { ok: true; release: () => void } | { ok: false; holder: string }
/** One atomic attempt (O_EXCL). A lock whose pid is dead, or older than MAX_HOLD_MS, is removed and retried once. */
export function tryFileLock(path: string, id: string, now = Date.now()): FileLock {
  const body = `${process.pid} ${new Date(now).toISOString()} ${id}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, body)
      closeSync(fd)
      return { ok: true, release: () => { try { if (readFileSync(path, 'utf8') === body) unlinkSync(path) } catch { /* already gone */ } } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let cur = ''
      try { cur = readFileSync(path, 'utf8') } catch { continue }
      const m = /^(\d+) (\S+)/.exec(cur)
      const stale = !m || !pidAlive(Number(m[1])) || now - Date.parse(m[2]!) > MAX_HOLD_MS
      if (!stale) return { ok: false, holder: cur }
      try { unlinkSync(path) } catch { /* raced with another waiter */ }
    }
  }
  return { ok: false, holder: 'lock file kept reappearing' }
}

// ---- layer 2: blackboard key ---------------------------------------------------------------------------------------
const conclave = (args: string[]): { ok: boolean; out: string } => {
  try {
    const r = Bun.spawnSync(['conclave', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CONCLAVE_NO_CAP: '1' } })
    return { ok: r.exitCode === 0, out: r.stdout.toString() }
  } catch {
    return { ok: false, out: '' }
  }
}
/** 'free' only when the CLI answered and the key is absent; any failure is 'unreadable' (treated as held). */
function readKey(ws: string): { state: 'free' } | { state: 'held'; value: string } | { state: 'unreadable' } {
  const r = conclave(['bb', 'get', ws, LOCK_KEY])
  if (!r.ok) return { state: 'unreadable' }
  let j: unknown
  try { j = JSON.parse(r.out) } catch { return { state: 'unreadable' } }
  if (j === null) return { state: 'free' }
  const v = (j as { value?: unknown } | null)?.value
  return typeof v === 'string' ? { state: 'held', value: v } : { state: 'unreadable' }
}

export async function acquireHostLock(say: (s: string) => void): Promise<() => void> {
  const ws = process.env.BENCH_LOCK_WS
  const id = process.env.BENCH_LOCK_ID ?? `bench pid-${process.pid}`
  const deadline = Date.now() + MAX_HOLD_MS
  let file: FileLock
  for (;;) {
    file = tryFileLock(LOCK_FILE, id)
    if (file.ok) break
    if (Date.now() > deadline) throw new Error(`host lock file ${LOCK_FILE} still held (${file.holder}) after ${MAX_HOLD_MS / 60000} min`)
    say(`host lock file held (${file.holder}) — waiting`)
    await Bun.sleep(15_000)
  }
  let released = false
  let value = ''
  const release = () => {
    if (released) return
    released = true
    if (ws && value && readKey(ws).state === 'held' && (readKey(ws) as { value?: string }).value === value) conclave(['bb', 'delete', ws, LOCK_KEY])
    if (file.ok) file.release()
    console.log('[bench] host lock released')
  }
  process.on('exit', release)
  try {
    if (ws) {
      for (;;) {
        const k = readKey(ws)
        if (k.state === 'free') break
        if (k.state === 'unreadable') throw new Error('bench:host-lock is unreadable (conclave bb get failed) — refusing to measure; fix the CLI or unset BENCH_LOCK_WS to use the lock file alone')
        const cur = parseLock(k.value)
        if (cur && isStale(cur)) break
        if (Date.now() > deadline) throw new Error(`bench:host-lock still held by ${k.value} after ${MAX_HOLD_MS / 60000} min`)
        say(`bb ${LOCK_KEY} held by ${k.value} — waiting`)
        await Bun.sleep(15_000)
      }
      value = `${id} ${new Date().toISOString()}`
      if (!conclave(['bb', 'set', ws, LOCK_KEY, value]).ok) throw new Error('could not set bb bench:host-lock')
      const back = readKey(ws)
      if (back.state !== 'held' || back.value !== value) { value = ''; throw new Error('bench:host-lock was taken by someone else between our read and set — rerun') }
    } else say('BENCH_LOCK_WS unset: holding the lock file only (the shared blackboard key is not set)')
  } catch (e) {
    release()
    throw e
  }
  // The holder enforces the cap on itself too.
  setTimeout(() => { console.error(`[bench] host lock held for ${MAX_HOLD_MS / 60000} min — aborting the run`); process.exit(1) }, MAX_HOLD_MS).unref()
  say(`host lock acquired: ${value || id} (file ${LOCK_FILE})`)
  return release
}
