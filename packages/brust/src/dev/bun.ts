// `brust dev` for the Bun target (R13): a long-lived parent owns the port (proxy.ts), every successful
// build is booted as a NEW child (`brust start` on a loopback port) and swapped in blue/green. A failed
// build or a failed boot keeps the old child serving. Never an in-process reload: one SERVER per
// process, workers never restart, SABs are never freed (R13.1).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../config'
import { type Diag, parseBuildError, parseWarnings } from './diag'
import { tierCounts } from './devtools-data'
import { type DevProxy, startProxy } from './proxy'
import { HOTKEYS, Tui, type TuiOut, tuiMode } from './tui'
import { loadBuildConfig } from '../build/config'
import { broadRootWarnings, changeLine, defaultIgnored, watchLoop } from './watch'

export interface BunDevOptions {
  appRoot: string
  entry: string
  port?: number
  /** Bun workers of each child; default 1 (R13.4). */
  workers?: number
  out?: TuiOut
  env?: Record<string, string | undefined>
  /** Fires with the user-visible URL once the proxy listens (tests). */
  onListening?: (url: string) => void
}

const DEBOUNCE_MS = 150
const BOOT_TIMEOUT_MS = 60_000
const TAIL_LINES = 40
const cliPath = join(import.meta.dir, '..', 'cli.ts')

/** The `[actions] prefix` of the build in `dir` (its manifest), or null when there is none. */
export function readActionsPrefix(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { actions?: { prefix?: string } | null }).actions?.prefix ?? null
  } catch {
    return null
  }
}

/** `read` once per active build: each build is booted as its own child in its own `g<n>` dir, so the child object changes exactly when the build does. */
export function perBuild<C extends { dir: string }, T>(read: (dir: string) => T): (c: C | null) => T | null {
  let last: [C, T] | undefined
  return (c) => {
    if (!c) return null
    if (last?.[0] !== c) last = [c, read(c.dir)]
    return last[1]
  }
}

/** A free loopback port (bind port 0, read it, release it). */
export function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const p = s.port as number
  s.stop(true)
  return p
}

function pumpLines(stream: ReadableStream<Uint8Array> | null | undefined, onLine: (l: string) => void): void {
  if (!stream) return
  void (async () => {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true })
      let i = buf.indexOf('\n')
      while (i >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''))
        buf = buf.slice(i + 1)
        i = buf.indexOf('\n')
      }
    }
    if (buf) onLine(buf)
  })()
}

/** L19/L21 dev swap: the built stylesheets of the old and the new generation, paired by source stem
 * (`<stem>-<hex10>.css`), as `/_brust/client/<old>` → `/_brust/client/<new>`. `null` when the pairing is not
 * one-to-one (a stylesheet was added or removed, or two sources share a stem): the page must reload. */
export function cssSwapMap(oldDir: string, newDir: string): Record<string, string> | null {
  const byStem = (dir: string) => {
    const m = new Map<string, string>()
    let files: string[] = []
    try {
      files = readdirSync(join(dir, 'client'))
    } catch {}
    for (const f of files) {
      const s = /^(.*)-[0-9a-f]{10}\.css$/.exec(f)?.[1]
      if (s === undefined) continue
      if (m.has(s)) return null
      m.set(s, f)
    }
    return m
  }
  const a = byStem(oldDir)
  const b = byStem(newDir)
  if (!a || !b || a.size !== b.size) return null
  const map: Record<string, string> = {}
  for (const [stem, f] of a) {
    const g = b.get(stem)
    if (g === undefined) return null
    if (g !== f) map[`/_brust/client/${f}`] = `/_brust/client/${g}`
  }
  return map
}

/** The child server's own tracing chatter is not forwarded; the app's console output is. */
const NOISE = /\b(INFO|DEBUG)\b|^\[brust\] (listening on|ready)|^\s*$/

interface Child {
  proc: ReturnType<typeof Bun.spawn>
  port: number
  dir: string
}

export async function runBunDev(o: BunDevOptions): Promise<number> {
  const appRoot = resolve(o.appRoot)
  const entry = resolve(appRoot, o.entry)
  const out: TuiOut = o.out ?? (process.stdout as unknown as TuiOut)
  const env = o.env ?? process.env
  const mode = tuiMode(out, env)
  const tui = new Tui(out, mode.interactive, mode.color)
  const cfg = await loadConfig(appRoot, o.port !== undefined ? { port: o.port } : {})
  const workers = o.workers ?? 1
  const devRoot = join(appRoot, '.brust', 'dev')
  rmSync(devRoot, { recursive: true, force: true })
  mkdirSync(devRoot, { recursive: true })

  // R14.1: only this process and its children know the token; the core traces a request only if it carries it.
  const devToken = crypto.randomUUID()
  let counter = 0
  let gen = 0
  let state: 'building' | 'ready' | 'error' = 'building'
  let diag: Diag | null = null
  let active: Child | null = null
  let buildMs: number | undefined
  let warnings: string[] = []
  let last: { method: string; path: string; status: number; tiers?: { static: number; native: number; react: number } } | undefined
  let stopping = false
  let url = ''
  /** Processes spawned by an in-flight cycle (a build, a booting child): `stop()` must reach them (R13.5, own PIDs only). */
  const inflight = new Set<ReturnType<typeof Bun.spawn>>()

  const publish = () =>
    tui.setStatus({
      state,
      url,
      gen,
      buildMs,
      last,
      warnings,
      error: diag && state === 'error' ? `${diag.rule} ${diag.file ? `${diag.file}${diag.line ? `:${diag.line}` : ''} ` : ''}${diag.message}`.trim() : undefined,
    })

  const prefixOf = perBuild<Child, string | null>(readActionsPrefix)

  const devMeta = (): unknown | null => {
    try {
      return active ? JSON.parse(readFileSync(join(active.dir, 'dev.json'), 'utf8')) : null
    } catch {
      return null
    }
  }

  const proxy: DevProxy = startProxy(
    { hostname: cfg.host, port: cfg.port, token: devToken },
    {
      gen: () => gen,
      state: () => state,
      diag: () => diag,
      upstream: () => active?.port ?? null,
      meta: devMeta,
      actionsPrefix: () => prefixOf(active),
      onRequest(r) {
        tui.log(`${r.method} ${r.path} ${r.status} ${r.ms}ms${r.cache ? ` ${r.cache}` : ''}`)
        if (!r.path.startsWith('/_brust/')) {
          const rendered = (r.trace as { rendered?: string[] } | null)?.rendered
          last = { method: r.method, path: r.path, status: r.status, ...(rendered ? { tiers: tierCounts(rendered, devMeta() as Parameters<typeof tierCounts>[1]) } : {}) }
          publish()
        }
      },
    },
  )
  url = `http://${cfg.host}:${proxy.port}`
  o.onListening?.(url)

  /** Build into `dir`; a child process, so module caches never leak between builds. */
  async function build(dir: string): Promise<{ ok: boolean; text: string; ms: number }> {
    const t0 = performance.now()
    const p = Bun.spawn([process.execPath, cliPath, 'build', o.entry, '--out-dir', dir, '--dev'], {
      cwd: appRoot,
      env: { ...process.env, NODE_ENV: 'development', BRUST_BUILD_MODE: 'development' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    inflight.add(p)
    const [so, se, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    inflight.delete(p)
    return { ok: code === 0, text: `${so}\n${se}`, ms: Math.round(performance.now() - t0) }
  }

  /** Boot `brust start` over `dir`; resolves once `[brust] ready`, rejects with the output tail. */
  function boot(dir: string): Promise<Child> {
    const port = freePort()
    const proc = Bun.spawn([process.execPath, cliPath, 'start', '--dist-dir', dir, '--entry', entry, '--workers', String(workers)], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        BRUST_PORT: String(port),
        BRUST_ADDR: '127.0.0.1',
        BRUST_WORKERS: String(workers),
        BRUST_DIST_DIR: dir,
        BRUST_APP_ENTRY: entry,
        BRUST_DEV_TOKEN: devToken,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    inflight.add(proc)
    const tail: string[] = []
    let ready = false
    return new Promise<Child>((resolveBoot, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error(`the new build did not become ready within ${BOOT_TIMEOUT_MS / 1000}s\n${tail.join('\n')}`))
      }, BOOT_TIMEOUT_MS)
      const line = (l: string) => {
        tail.push(l)
        if (tail.length > TAIL_LINES) tail.shift()
        if (!ready && /\[brust\] ready/.test(l)) {
          ready = true
          clearTimeout(timer)
          resolveBoot({ proc, port, dir })
        } else if (ready && !NOISE.test(l)) tui.log(l)
      }
      pumpLines(proc.stdout as ReadableStream<Uint8Array>, line)
      pumpLines(proc.stderr as ReadableStream<Uint8Array>, line)
      void proc.exited.then((code) => {
        inflight.delete(proc)
        clearTimeout(timer)
        if (!ready) reject(new Error(`the new build exited with code ${code} before it was ready\n${tail.join('\n')}`))
        else if (active?.proc === proc && !stopping) tui.log(`[brust] the server process exited (code ${code})`)
      })
    })
  }

  async function stopChild(c: Child): Promise<void> {
    c.proc.kill('SIGINT')
    if ((await Promise.race([c.proc.exited, Bun.sleep(4000).then(() => undefined)])) === undefined) {
      c.proc.kill('SIGKILL')
      await c.proc.exited
    }
    rmSync(c.dir, { recursive: true, force: true })
  }

  function fail(d: Diag): void {
    state = 'error'
    diag = d
    proxy.broadcast({ type: 'error', diag: d })
    tui.log(`[brust] ${d.rule}${d.file ? ` ${d.file}${d.line ? `:${d.line}${d.col ? `:${d.col}` : ''}` : ''}` : ''} ${d.message}`)
    publish()
  }

  /** One build -> boot -> swap cycle. */
  async function cycle(cssOnly = false): Promise<void> {
    state = 'building'
    publish()
    const g = ++counter
    const dir = join(devRoot, `g${g}`)
    const b = await build(dir)
    if (stopping) {
      rmSync(dir, { recursive: true, force: true })
      return
    }
    warnings = parseWarnings(b.text)
    if (!b.ok) {
      rmSync(dir, { recursive: true, force: true })
      fail(parseBuildError(b.text) ?? { rule: 'build', message: b.text.trim().split('\n').pop() ?? 'build failed', raw: b.text.trim() })
      return
    }
    let child: Child
    try {
      child = await boot(dir)
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      if (stopping) return
      const raw = (e as Error).message
      fail({ rule: 'boot', message: raw.split('\n')[0] ?? raw, raw })
      return
    }
    // Stopped while this child booted, or a newer generation already took over: this child must not be adopted.
    if (stopping || g < gen) {
      await stopChild(child)
      return
    }
    const old = active
    active = child
    gen = g
    buildMs = b.ms
    state = 'ready'
    diag = null
    // A stylesheet-only edit (L19/L21): the pages keep their DOM and swap their brust CSS links.
    const swap = cssOnly && old ? cssSwapMap(old.dir, child.dir) : null
    if (swap) {
      proxy.broadcast({ type: 'css-swap', gen, map: swap })
      tui.log(`[brust] css rebuilt (${Object.keys(swap).length} stylesheet${Object.keys(swap).length === 1 ? '' : 's'} swapped, no reload)`)
    } else proxy.broadcast({ type: 'reload', gen })
    publish()
    if (old) void stopChild(old)
  }

  const isCss = (rel: string) => rel.startsWith('public/') && rel.endsWith('.css')

  // F273: `[build] source_roots` are watched too (a bad config is the build's error to report, not the watcher's)
  const extraRoots = await loadBuildConfig(appRoot).then((c) => c.sourceRoots.map((r) => resolve(appRoot, r)), () => [] as string[])
  for (const w of broadRootWarnings(extraRoots, appRoot)) tui.log(w)
  const loop = watchLoop({
    root: appRoot,
    extraRoots,
    ignored: (rel) => defaultIgnored(rel, 'dist'),
    debounceMs: DEBOUNCE_MS,
    async run(changed) {
      // A change to public/*.css skips the build: copy it into the active dist and swap the <link> (R13.3).
      if (active && state === 'ready' && [...changed].every((r) => isCss(r) && existsSync(join(appRoot, r)))) {
        const v = Date.now()
        for (const rel of changed) {
          cpSync(join(appRoot, rel), join(active.dir, rel))
          proxy.broadcast({ type: 'css', href: `/${rel}`, v })
        }
        tui.log(`[brust] css ${[...changed].join(', ')} (no reload)`)
        return
      }
      const line = changeLine(changed)
      if (line) tui.log(line)
      // Only built stylesheets changed (L19/L21): rebuild, boot, then swap the links instead of reloading.
      await cycle(active !== null && state === 'ready' && [...changed].every((r) => r.endsWith('.css') && !isCss(r)))
    },
  })

  let exit: (code: number) => void = () => {}
  const done = new Promise<number>((r) => {
    exit = r
  })
  let stdinRaw = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    loop.close()
    proxy.stop()
    if (stdinRaw) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    tui.close()
    // A build or a booting child of an in-flight cycle: SIGINT, then SIGKILL (own PIDs only).
    const mid = [...inflight]
    for (const p of mid) p.kill('SIGINT')
    await Promise.all(mid.map(async (p) => {
      if ((await Promise.race([p.exited, Bun.sleep(4000).then(() => undefined)])) === undefined) p.kill('SIGKILL')
    }))
    if (active) await stopChild(active)
    rmSync(devRoot, { recursive: true, force: true })
    exit(0)
  }

  if (mode.interactive && process.stdin.isTTY) {
    stdinRaw = true
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (b) => {
      for (const k of b.toString()) {
        if (k === 'q' || k === '\x03') void stop()
        else if (k === 'r') proxy.broadcast({ type: 'reload' })
        else if (k === 'o') Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], { stdout: 'ignore', stderr: 'ignore' })
        else if (k === 'w') for (const w of warnings.length ? warnings : ['no warnings']) tui.log(`warning ${w}`)
        else if (k === 'c') tui.clear()
      }
    })
    ;(out as unknown as NodeJS.WriteStream).on?.('resize', () => tui.resize())
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())

  tui.log(`[brust] dev server on ${url} — ${HOTKEYS}`)
  publish()
  // The first build goes through the loop too, so it is single-flight with every later one: an edit saved while it
  // runs waits for it and then builds on top (never a second cycle racing the first).
  loop.trigger('.')
  void loop.idle()
  return done
}
