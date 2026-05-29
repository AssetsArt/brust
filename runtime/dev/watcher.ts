import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

export type ChangeKind = 'ts' | 'css' | 'component-css' | 'html' | 'islands'

const IGNORE_DIR_SEGMENTS = new Set(['node_modules', '.git', '.brust', 'dist'])
const TS_RE = /\.(tsx?|jsx?)$/
const TEST_RE = /\.test\.(tsx?|jsx?)$/

/** Classify a changed path. Returns null when the path should be ignored.
 * `root` is used to compute the relative path for ignore-segment matching. */
export function classifyPath(absPath: string, root: string): ChangeKind | null {
  const rel = path.relative(root, absPath)
  const segs = rel.split(path.sep)
  for (const s of segs) {
    if (IGNORE_DIR_SEGMENTS.has(s)) return null
  }
  if (TEST_RE.test(absPath)) return null

  const base = path.basename(absPath)
  if (base === 'island.config.ts') return 'islands'
  if (base === 'app.css') return 'css'
  // skip generated module type declarations
  if (absPath.endsWith('.module.css.d.ts')) return null
  // any other .css (including .module.css) is component CSS
  if (absPath.endsWith('.css')) return 'component-css'
  if (absPath.endsWith('.html')) return 'html'
  if (TS_RE.test(absPath)) return 'ts'
  return null
}

interface Coalesce {
  add(path: string): void
  flush(): void
}

/** Internal — exposed for unit tests. */
export function _testCoalesce(debounceMs: number, flush: (paths: string[]) => void): Coalesce {
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    add(p) {
      pending.add(p)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const out = Array.from(pending)
        pending = new Set()
        timer = null
        flush(out)
      }, debounceMs)
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pending.size > 0) {
        const out = Array.from(pending)
        pending = new Set()
        flush(out)
      }
    },
  }
}

export interface CreateWatcherOptions {
  root: string
  debounceMs?: number
  onChange: (ev: { paths: string[]; kind: ChangeKind }) => void
}

export interface Watcher {
  close(): void
}

/** Watch `root` recursively. Emits one `onChange` call per debounce window
 * with paths classified by the dominant kind. Mixed-kind windows pick
 * by priority: islands > ts > html > css (islands trigger a full restart
 * that subsumes the others). */
export function createWatcher(opts: CreateWatcherOptions): Watcher {
  const debounceMs = opts.debounceMs ?? 50
  const kindPriority: ChangeKind[] = ['islands', 'ts', 'html', 'css', 'component-css']

  const coalesce = _testCoalesce(debounceMs, (paths) => {
    const kinds = new Set<ChangeKind>()
    const keep: string[] = []
    for (const p of paths) {
      const k = classifyPath(p, opts.root)
      if (k === null) continue
      kinds.add(k)
      keep.push(p)
    }
    if (keep.length === 0) return
    const dominant = kindPriority.find((k) => kinds.has(k))!
    opts.onChange({ paths: keep, kind: dominant })
  })

  const fsWatcher: FSWatcher = watch(opts.root, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const abs = path.resolve(opts.root, filename)
    coalesce.add(abs)
  })

  return {
    close() {
      fsWatcher.close()
      coalesce.flush()
    },
  }
}
