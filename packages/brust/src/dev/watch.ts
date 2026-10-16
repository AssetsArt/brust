// The shared watch/build loop of `brust dev` (bun and cloudflare targets): debounced file events,
// ONE run at a time, and every change that arrives while a run is in flight is kept for the next
// run (post-mortem 8f29c26: an edit during a rebuild was dropped). `run` receives the app-relative
// paths that changed since the previous run started.
import { type FSWatcher, readdirSync, statSync, watch } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export interface WatchLoop {
  /** Queue a run as if `rel` changed (the `r` hotkey, tests). */
  trigger(rel?: string): void
  /** Stop watching and drop queued changes; an in-flight run is left to finish. */
  close(): void
  /** Resolves when no run is in flight and nothing is queued. */
  idle(): Promise<void>
}

/** F273: a source root holding more files than this gets a warning (a root that broad slows every rebuild check). */
export const ROOT_FILE_WARN = 5_000

/** Files under `dir` (skipping dependency/VCS dirs), counting stops once past `limit`. */
export function countFiles(dir: string, limit: number): number {
  let n = 0
  const walk = (d: string): void => {
    let ents: import('node:fs').Dirent[]
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (n > limit) return
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name))
      } else n++
    }
  }
  walk(dir)
  return n
}

/** Warning lines for source roots broader than `ROOT_FILE_WARN` files; `roots` are absolute. */
export function broadRootWarnings(roots: string[], appRoot: string, limit = ROOT_FILE_WARN): string[] {
  return roots.flatMap((r) => (countFiles(r, limit) > limit ? [`[brust] warning: source root ${relative(appRoot, r) || r} holds more than ${limit} files; watching it slows every change check. Point source_roots at a narrower directory`] : []))
}

export function watchLoop(o: { root: string; /** F273: `[build] source_roots`, absolute: watched too; their changes are reported app-relative (`../shared/x.ts`). */ extraRoots?: string[]; ignored: (rel: string) => boolean; debounceMs: number; run: (changed: Set<string>) => Promise<void> }): WatchLoop {
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
  const onEvent = (base: string) => (_ev: string, name: string | null) => {
    if (!name) return
    const abs = join(base, String(name))
    const rel = (base === o.root ? String(name) : relative(o.root, abs)).split(sep).join('/')
    if (o.ignored(rel)) return
    // A directory's own event is metadata noise (reading a dir bumps its atime, which FSEvents reports): a real
    // change inside it reports the file itself. A path that no longer exists is a delete, which counts.
    try {
      if (statSync(abs).isDirectory()) return
    } catch {}
    queue(rel)
  }
  const watchers: FSWatcher[] = [watch(o.root, { recursive: true }, onEvent(o.root))]
  for (const r of o.extraRoots ?? []) {
    const abs = resolve(r)
    // a root inside the app is already watched; one that cannot be watched must not stop the session
    if (abs === o.root || abs.startsWith(o.root + sep)) continue
    try {
      watchers.push(watch(abs, { recursive: true }, onEvent(abs)))
    } catch (e) {
      console.error(`[brust] cannot watch source root ${abs}: ${(e as Error).message}`)
    }
  }
  return {
    trigger: (rel = '.') => queue(rel),
    close() {
      closed = true
      clearTimeout(timer)
      pending.clear()
      for (const w of watchers) w.close()
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
