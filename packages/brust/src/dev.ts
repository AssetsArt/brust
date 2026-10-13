// `brust dev [entry] --target cloudflare [-- <wrangler args>]` (M4-CF R10): build, run `wrangler dev` on the
// generated project, rebuild + restart wrangler on a source change. No HMR. Each build runs in a child
// process: a failed build keeps the old wrangler, and module caches never leak between builds.
import { join, relative, resolve } from 'node:path'
import { BuildError } from './build/errors'
import { defaultIgnored, type WatchLoop, watchLoop } from './dev/watch'

export interface DevOptions {
  appRoot: string
  entry: string
  outDir: string
  port?: number
  wranglerArgs: string[]
  fromSource: boolean
  log: (s: string) => void
}

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
      loop.close()
      exitCode(code)
    })
  }
  const stopChild = async () => {
    const c = child
    if (!c) return
    c.kill('SIGTERM')
    await c.exited
  }

  // The shared watch/build loop (dev/watch.ts): one rebuild at a time, edits during a rebuild are kept for the next.
  const loop: WatchLoop = watchLoop({
    root: appRoot,
    ignored: (rel) => defaultIgnored(rel, relative(appRoot, dist)),
    debounceMs: DEBOUNCE_MS,
    async run() {
      o.log('[brust] change detected; rebuilding')
      if ((await build()) === 0) {
        restarting = true
        await stopChild()
        restarting = false
        if (!stopping) spawn()
      } else o.log('[brust] rebuild failed; keeping the running wrangler')
    },
  })

  spawn()
  const stop = () => {
    if (stopping) return
    stopping = true
    loop.close()
    void stopChild().then(() => exitCode(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return done
}
