// The shared watch/build loop of `brust dev` (bun and cloudflare targets): debounced file events,
// ONE run at a time, and every change that arrives while a run is in flight is kept for the next
// run (post-mortem 8f29c26: an edit during a rebuild was dropped). `run` receives the app-relative
// paths that changed since the previous run started.
import { type FSWatcher, statSync, watch } from 'node:fs'
import { join, sep } from 'node:path'

export interface WatchLoop {
  /** Queue a run as if `rel` changed (the `r` hotkey, tests). */
  trigger(rel?: string): void
  /** Stop watching and drop queued changes; an in-flight run is left to finish. */
  close(): void
  /** Resolves when no run is in flight and nothing is queued. */
  idle(): Promise<void>
}

export function watchLoop(o: { root: string; ignored: (rel: string) => boolean; debounceMs: number; run: (changed: Set<string>) => Promise<void> }): WatchLoop {
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let closed = false
  let idleWaiters: (() => void)[] = []
  const pump = async () => {
    if (running) return // the running loop picks `pending` up when it finishes
    running = true
    try {
      while (pending.size > 0 && !closed) {
        const batch = pending
        pending = new Set()
        try {
          await o.run(batch)
        } catch (e) {
          console.error(`[brust] dev run failed: ${(e as Error).stack ?? String(e)}`)
        }
      }
    } finally {
      running = false
      if (pending.size === 0) for (const w of idleWaiters.splice(0)) w()
    }
  }
  const queue = (rel: string) => {
    if (closed) return
    pending.add(rel)
    clearTimeout(timer)
    timer = setTimeout(() => void pump(), o.debounceMs)
  }
  const watcher: FSWatcher = watch(o.root, { recursive: true }, (_ev, name) => {
    if (!name) return
    const rel = String(name).split(sep).join('/')
    if (o.ignored(rel)) return
    // A directory's own event is metadata noise (reading a dir bumps its atime, which FSEvents reports): a real
    // change inside it reports the file itself. A path that no longer exists is a delete, which counts.
    try {
      if (statSync(join(o.root, rel)).isDirectory()) return
    } catch {}
    queue(rel)
  })
  return {
    trigger: (rel = '.') => queue(rel),
    close() {
      closed = true
      clearTimeout(timer)
      pending.clear()
      watcher.close()
      for (const w of idleWaiters.splice(0)) w()
    },
    idle: () => (!running && pending.size === 0 ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r))),
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', '.brust'])
const SKIP_FILE = /(^|\/)(\.DS_Store|4913)$|~$|\.(swp|swx|tmp|log)$|\.(sqlite|db)(-wal|-shm|-journal)?$/

/** Paths a dev session never rebuilds for: dependency/VCS dirs, brust's own output, editor temp files, databases. */
export function defaultIgnored(rel: string, outDirRel: string): boolean {
  const segs = rel.split('/')
  if (segs.some((s) => SKIP_DIRS.has(s))) return true
  const out = outDirRel.replace(/\/+$/, '')
  if (rel === out || rel.startsWith(`${out}/`) || rel.startsWith(`${out}.`) || rel.startsWith(`.${out}.brust-`)) return true
  return SKIP_FILE.test(rel)
}
