// F189: `Bun.resolveSync` answers the CJS `main` of a package that has both (recharts: `main` is a CJS build, `module`
// the ES build), so a package resolved from a directory the bundler does not walk (a package's own, for what its source
// imports) became a second, CJS copy beside the ESM one every other island imports. Re-implementing the bundler's
// choice drifts (conditions per target, the `browser` field, `development`, `module` before `import`), so this asks
// the bundler itself: a throwaway `Bun.build` of a virtual file placed in `from` that imports `spec`, with the same
// `target`; the first module the build loads from outside that file is the answer. Equal to the native pick by
// construction. It runs in a child process: a `Bun.build` started inside a plugin callback of another build deadlocks.
// Anything it cannot resolve falls back to `Bun.resolveSync`, which is today's answer, and says so (F222).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ResolveTarget = 'bun' | 'browser'

/** What a build besides `target` and `define` tells the bundler about resolution, and where the probe runs. */
export interface ResolveOpts {
  /** The build's `conditions` (`--target cloudflare`: workerd, worker, browser). Part of the answer, so part of the key. */
  conditions?: string[]
  /** The app root: the probe's working directory (F221) and the home of the cross-build cache (F224). */
  appRoot?: string
  /** Kills a probe that does not answer; default `RESOLVE_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Where a fallback is named (F222); default: a `warning` line on stderr. */
  warn?: (message: string) => void
}

/** `BRUST_RESOLVE_TIMEOUT_MS` or 30 s: a healthy probe answers in well under a second. */
export const RESOLVE_TIMEOUT_MS = Number(process.env.BRUST_RESOLVE_TIMEOUT_MS) > 0 ? Number(process.env.BRUST_RESOLVE_TIMEOUT_MS) : 30_000

const cache = new Map<string, string>()

/** Forgets the in-process answers and warnings (tests; the disk cache stays). */
export function clearResolveCache(): void {
  cache.clear()
  warned.clear()
  disks.clear()
}

// argv: [target, entry, spec, define JSON, conditions JSON]; prints the resolved path. The define is the build's own:
// `NODE_ENV` flips Bun's `development` condition, so a probe without it picks another file than the build does. The
// same goes for `conditions`.
const PROBE = `
const [target, entry, spec, define, conditions] = process.argv.slice(1)
const source = 'import ' + JSON.stringify(spec) + '\\n'
let found
await Bun.build({
  entrypoints: [entry], target, write: false, define: JSON.parse(define), conditions: JSON.parse(conditions), files: { [entry]: source },
  plugins: [{ name: 'o', setup(b) { b.onLoad({ filter: /./ }, (a) => {
    if (a.path === entry) return { contents: source, loader: 'ts' }
    found ??= a.path
    return { contents: '', loader: 'js' }
  }) } }],
})
if (found) process.stdout.write(found)
`

const defaultWarn = (m: string) => console.warn(`warning resolve-fallback ${m}`)
const warned = new Set<string>()

/** `spec` as the bundler of `target` resolves it from the directory `from`. */
export function resolveNative(spec: string, from: string, target: ResolveTarget, define: Record<string, string> = {}, opts: ResolveOpts = {}): string {
  const defs = JSON.stringify(define)
  const conds = JSON.stringify(opts.conditions ?? [])
  const key = `${target}\0${from}\0${spec}\0${defs}\0${conds}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const disk = opts.appRoot !== undefined ? diskCache(opts.appRoot, `${target}\0${defs}\0${conds}`) : undefined
  const saved = disk?.get(`${from}\0${spec}`)
  if (saved !== undefined) {
    cache.set(key, saved)
    return saved
  }
  const timeout = opts.timeoutMs ?? RESOLVE_TIMEOUT_MS
  const r = Bun.spawnSync([process.execPath, '-e', PROBE, target, join(from, '__brust_resolve__.ts'), spec, defs, conds], { cwd: opts.appRoot ?? from, stdout: 'pipe', stderr: 'pipe', timeout, killSignal: 'SIGKILL' })
  const out = r.exitCode === 0 ? r.stdout.toString() : ''
  let path = out
  if (path === '') {
    // The probe did not answer: today's answer (`Bun.resolveSync`) stands, and the build output says why.
    const why = r.exitCode === null || r.signalCode ? `the probe did not answer within ${timeout} ms` : r.exitCode !== 0 ? `the probe failed (${r.stderr.toString().trim().split('\n')[0] || `exit ${r.exitCode}`})` : 'the probe resolved nothing'
    path = Bun.resolveSync(spec, from)
    const msg = `${spec} from ${from} (${target}): ${why}; used Bun.resolveSync -> ${path}`
    if (!warned.has(msg)) {
      warned.add(msg)
      ;(opts.warn ?? defaultWarn)(msg)
    }
  } else disk?.set(`${from}\0${spec}`, path)
  cache.set(key, path)
  return path
}

// F224: a probe is a child process plus a `Bun.build`: ~100-300 ms each, once per (package dir, specifier) in a build,
// and again in every build. The answers are kept across builds in `<appRoot>/.brust/resolve-cache.json`, valid for one
// lockfile and one Bun, per (target, define, conditions); an entry is dropped when its file is gone or the nearest
// `package.json` above it changed (a linked workspace package edits without touching the lockfile).
interface Saved { path: string; pkg: string; mtime: number }
const LOCKS = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
const disks = new Map<string, DiskCache | null>()

class DiskCache {
  private entries: Record<string, Saved> = {}
  constructor(private file: string, private salt: string) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (j.salt === salt) this.entries = j.entries ?? {}
    } catch {}
  }
  get(k: string): string | undefined {
    const e = this.entries[k]
    if (!e) return undefined
    try {
      if (existsSync(e.path) && (e.pkg === '' || statSync(e.pkg).mtimeMs === e.mtime)) return e.path
    } catch {}
    delete this.entries[k]
    return undefined
  }
  set(k: string, path: string): void {
    let pkg = ''
    let mtime = 0
    for (let d = dirname(path); ; d = dirname(d)) {
      const p = join(d, 'package.json')
      if (existsSync(p)) {
        pkg = p
        mtime = statSync(p).mtimeMs
        break
      }
      if (dirname(d) === d) break
    }
    this.entries[k] = { path, pkg, mtime }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ salt: this.salt, entries: this.entries }))
      renameSync(tmp, this.file)
    } catch {}
  }
}

/** The cache for this app and (target, define, conditions), or none when no lockfile pins the install. */
function diskCache(appRoot: string, scope: string): DiskCache | undefined {
  const id = `${appRoot}\0${scope}`
  const have = disks.get(id)
  if (have !== undefined) return have ?? undefined
  let lock: string | undefined
  for (let d = appRoot; lock === undefined; d = dirname(d)) {
    lock = LOCKS.map((l) => join(d, l)).find((f) => existsSync(f))
    if (dirname(d) === d) break
  }
  let made: DiskCache | null = null
  if (lock !== undefined) {
    try {
      const salt = createHash('sha256').update(Bun.version).update(readFileSync(lock)).update(scope).digest('hex')
      made = new DiskCache(join(appRoot, '.brust', `resolve-cache-${createHash('sha256').update(scope).digest('hex').slice(0, 8)}.json`), salt)
    } catch {}
  }
  disks.set(id, made)
  return made ?? undefined
}
