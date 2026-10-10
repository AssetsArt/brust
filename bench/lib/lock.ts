// bench/lib/lock.ts — the host-wide measurement lock (lead rule bench-host-lock): blackboard key `bench:host-lock`
// = '<slug> <agent> <ISO time>', held for at most 20 minutes. Active only when BENCH_LOCK_WS (workspace id) and
// BENCH_LOCK_ID ('<slug> <agent>') are set; otherwise the runner warns and relies on the load guard alone.
export const LOCK_KEY = 'bench:host-lock'
export const MAX_HOLD_MS = 20 * 60_000

export interface LockValue { owner: string; at: string }
/** `<slug> <agent> <ISO>` → parts; null when the value does not look like a lock. */
export function parseLock(v: string | null): LockValue | null {
  const m = v ? /^(\S+ \S+) (\d{4}-\d{2}-\d{2}T\S+)$/.exec(v.trim()) : null
  return m ? { owner: m[1]!, at: m[2]! } : null
}
/** A lock older than MAX_HOLD_MS is stale (its holder died); the waiter may replace it. */
export function isStale(l: LockValue, now = Date.now()): boolean {
  const t = Date.parse(l.at)
  return Number.isNaN(t) || now - t > MAX_HOLD_MS
}

const conclave = (args: string[]): { ok: boolean; out: string } => {
  try {
    const r = Bun.spawnSync(['conclave', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CONCLAVE_NO_CAP: '1' } })
    return { ok: r.exitCode === 0, out: r.stdout.toString() }
  } catch {
    return { ok: false, out: '' }
  }
}
const readLock = (ws: string): string | null => {
  const r = conclave(['bb', 'get', ws, LOCK_KEY])
  if (!r.ok) return null
  try { const v = (JSON.parse(r.out) as { value?: unknown }).value; return typeof v === 'string' ? v : null } catch { return null }
}

/** Wait until the key is free (or stale), set it, return the release function. */
export async function acquireHostLock(say: (s: string) => void): Promise<() => void> {
  const ws = process.env.BENCH_LOCK_WS
  const id = process.env.BENCH_LOCK_ID
  if (!ws || !id) { say('host lock: BENCH_LOCK_WS / BENCH_LOCK_ID unset — relying on the load guard only'); return () => {} }
  const deadline = Date.now() + MAX_HOLD_MS
  for (;;) {
    const cur = parseLock(readLock(ws))
    if (!cur || isStale(cur)) break
    if (Date.now() > deadline) throw new Error(`host lock still held by ${cur.owner} since ${cur.at} after ${MAX_HOLD_MS / 60000} min`)
    say(`host lock held by ${cur.owner} since ${cur.at} — waiting`)
    await Bun.sleep(15_000)
  }
  const value = `${id} ${new Date().toISOString()}`
  if (!conclave(['bb', 'set', ws, LOCK_KEY, value]).ok) throw new Error('could not set bb bench:host-lock')
  say(`host lock acquired: ${value}`)
  let released = false
  const release = () => { if (!released) { released = true; conclave(['bb', 'delete', ws, LOCK_KEY]); console.log('[bench] host lock released') } }
  process.on('exit', release)
  return release
}
