// `brust dev [entry] --target cloudflare [-- <wrangler args>]` (M4-CF R10): build, run `wrangler dev` on the
// generated project, rebuild + restart wrangler on a source change. No HMR. Each build runs in a child
// process: a failed build keeps the old wrangler, and module caches never leak between builds.
import { type FSWatcher, watch } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { BuildError } from './build/errors'

export interface DevOptions {
  appRoot: string
  entry: string
  outDir: string
  port?: number
  wranglerArgs: string[]
  fromSource: boolean
  log: (s: string) => void
}

const IGNORED = new Set(['node_modules', '.wrangler', '.git'])
const DEBOUNCE_MS = 300

function wranglerBin(appRoot: string): string {
  const fake = process.env.BRUST_WRANGLER
  if (fake) return fake
  const found = Bun.which('wrangler', { PATH: `${join(appRoot, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` })
  if (!found) throw new BuildError('cf-dev', 'wrangler not found (bun add -d wrangler)')
  return found
}

/** Resolves with the exit code once the session ends (SIGINT/SIGTERM -> 0, or the child's own exit code). */
export async function runDev(o: DevOptions): Promise<number> {
  const appRoot = resolve(o.appRoot)
  const dist = resolve(appRoot, o.outDir)
  const bin = wranglerBin(appRoot)
  const build = (): Promise<number> => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), 'build', o.entry, '--target', 'cloudflare', '--out-dir', o.outDir, ...(o.fromSource ? ['--wasm-from-source'] : [])], {
      cwd: appRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return p.exited
  }
  if ((await build()) !== 0) return 1

  const args = ['dev', '-c', join(dist, 'cf', 'wrangler.jsonc'), '--persist-to', join(appRoot, '.wrangler', 'state'), ...(o.port !== undefined ? ['--port', String(o.port)] : []), ...o.wranglerArgs]
  let child: ReturnType<typeof Bun.spawn> | null = null
  let stopping = false
  let restarting = false
  let exitCode: (c: number) => void = () => {}
  const done = new Promise<number>((r) => {
    exitCode = r
  })
  const spawn = () => {
    const c = Bun.spawn([bin, ...args], { cwd: appRoot, stdio: ['inherit', 'inherit', 'inherit'] })
    child = c
    c.exited.then((code) => {
      if (child !== c || stopping || restarting) return
      watcher?.close()
      exitCode(code)
    })
  }
  const stopChild = async () => {
    const c = child
    if (!c) return
    c.kill('SIGTERM')
    await c.exited
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let building = false
  let again = false
  const rebuild = async () => {
    if (building) {
      again = true
      return
    }
    building = true
    do {
      again = false
      o.log('[brust] change detected; rebuilding')
      if ((await build()) === 0) {
        restarting = true
        await stopChild()
        restarting = false
        if (!stopping) spawn()
      } else o.log('[brust] rebuild failed; keeping the running wrangler')
    } while (again && !stopping)
    building = false
  }
  const ignored = (rel: string) => {
    const abs = resolve(appRoot, rel)
    return rel.split(sep).some((s) => IGNORED.has(s)) || abs === dist || abs.startsWith(dist + sep) || abs.startsWith(`${dist}.`) || abs.startsWith(join(dirname(dist), `.${basename(dist)}.brust-`)) || relative(dist, abs) === ''
  }
  let watcher: FSWatcher | null = watch(appRoot, { recursive: true }, (_ev, name) => {
    if (!name || ignored(String(name))) return
    clearTimeout(timer)
    timer = setTimeout(() => void rebuild(), DEBOUNCE_MS)
  })

  spawn()
  const stop = () => {
    if (stopping) return
    stopping = true
    clearTimeout(timer)
    watcher?.close()
    void stopChild().then(() => exitCode(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return done
}
