import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

export type ChangeKind = 'ts' | 'css' | 'component-css' | 'html' | 'islands' | 'md'

const IGNORE_DIR_SEGMENTS = new Set(['node_modules', '.git', '.brust', 'dist'])
const TS_RE = /\.(tsx?|jsx?)$/
const TEST_RE = /\.test\.(tsx?|jsx?)$/
const KIND_PRIORITY: ChangeKind[] = ['islands', 'ts', 'md', 'html', 'css', 'component-css']

/** Classify a changed path. Returns null when the path should be ignored.
 * `root` is used to compute the relative path for ignore-segment matching.
 * `hasMdRoutes` gates the `'md'` kind (S4): when the app has no md routes, a
 * project `.md` edit (README.md, notes) must not trigger the full reload path
 * (island rebuild + worker restart) — it classifies as null instead. Defaults
 * to true for backward compatibility with callers that don't thread the flag. */
export function classifyPath(absPath: string, root: string, hasMdRoutes = true): ChangeKind | null {
  const rel = path.relative(root, absPath)
  const segs = rel.split(path.sep)
  for (const s of segs) {
    if (IGNORE_DIR_SEGMENTS.has(s)) return null
  }
  if (TEST_RE.test(absPath)) return null

  const base = path.basename(absPath)
  if (base === 'app.css') return 'css'
  // skip generated module type declarations
  if (absPath.endsWith('.module.css.d.ts')) return null
  // any other .css (including .module.css) is component CSS
  if (absPath.endsWith('.css')) return 'component-css'
  if (absPath.endsWith('.html')) return 'html'
  // md pages (task 2.9): a content edit re-splices the md templates and takes
  // the full ts-edit reload path (worker restart — see coordinator). Only when
  // the app actually has md routes — otherwise .md files are inert (null).
  if (absPath.endsWith('.md')) return hasMdRoutes ? 'md' : null
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
  /** Whether the app has md routes — gates `.md` classification (see
   * classifyPath). Defaults to true (back-compat). */
  hasMdRoutes?: boolean
  onChange: (ev: { paths: string[]; kind: ChangeKind }) => void
}

export interface Watcher {
  close(): void
}

/** Internal — exposed for deterministic callback-contract tests. */
export function _testDispatchChanges(
  paths: string[],
  opts: Pick<CreateWatcherOptions, 'root' | 'hasMdRoutes' | 'onChange'>,
): void {
  const grouped = new Map<ChangeKind, Set<string>>()
  for (const p of paths) {
    const kind = classifyPath(p, opts.root, opts.hasMdRoutes ?? true)
    if (kind === null) continue
    let group = grouped.get(kind)
    if (!group) {
      group = new Set()
      grouped.set(kind, group)
    }
    group.add(p)
  }
  for (const kind of KIND_PRIORITY) {
    const group = grouped.get(kind)
    if (group && group.size > 0) {
      opts.onChange({ paths: Array.from(group), kind })
    }
  }
}

/** Watch `root` recursively. Emits one `onChange` call for every distinct kind
 * retained in a debounce window. Priority orders delivery; it never discards
 * lower-priority kinds from a mixed window. */
export function createWatcher(opts: CreateWatcherOptions): Watcher {
  const debounceMs = opts.debounceMs ?? 50

  const coalesce = _testCoalesce(debounceMs, (paths) => {
    _testDispatchChanges(paths, opts)
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
