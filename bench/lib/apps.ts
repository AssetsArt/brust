// bench/lib/apps.ts — the four comparators (spec §1.1 / §1.3). Every app in production mode; ports fixed per app;
// the runner restarts a server per (app, probe) so every row starts from a cold process.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppId, AppSpec } from './app'
import type { ProbeId } from './probes'

export const ROOT = resolve(import.meta.dir, '../..')
/** Fixed port per app (base 38300 + 1..4; the old M2 runner owns 38201-38204, lead rule bench-host-lock).
 * BENCH_PORT_BASE shifts them. A concurrent bench still invalidates a measurement — the host lock and the load guard protect the numbers. */
const PORT_BASE = Number.parseInt(process.env.BENCH_PORT_BASE ?? '38300', 10)
const P = (n: number): number => PORT_BASE + n
const BRUST_BIN = join(ROOT, 'packages/brust/bin/brust')
const sh = (cmd: string[], cwd: string, log?: (s: string) => void): void => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  log?.(r.stdout.toString().trimEnd())
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} (cwd ${cwd}) exited ${r.exitCode}:\n${r.stderr.toString()}\n${r.stdout.toString()}`)
}
const out = (cmd: string[], cwd = ROOT): string => { const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' }); return r.exitCode === 0 ? r.stdout.toString().trim() : '?' }
const workers = () => process.env.BENCH_WORKERS ?? String(availableParallelism())

/** Standalone output lands under `.next/standalone/<path from outputFileTracingRoot>/server.js`. */
export function nextServerJs(cwd: string): string {
  const candidates = [join(cwd, '.next/standalone/bench/apps/next/server.js'), join(cwd, '.next/standalone/server.js')]
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) throw new Error(`next standalone server.js not found; looked at:\n  ${candidates.join('\n  ')}\n(run \`bun run build\` in bench/apps/next)`)
  return hit
}

/** Review Focus 5: the brust app must serve S from L1 and D/I from the loader on ?nocache=1. */
export async function brustSanity(base: string, probe: ProbeId): Promise<void> {
  const hdr = async (path: string) => (await fetch(`${base}${path}`)).headers.get('x-brust-cache')
  if (probe === 'S') {
    await hdr('/types')
    const second = await hdr('/types')
    if (second !== 'HIT') throw new Error(`brust sanity S: second /types answered x-brust-cache=${second}, expected HIT (cache: ttl_seconds on /types?)`)
  } else {
    const path = probe === 'D' ? '/dex?nocache=1' : '/team?nocache=1'
    await hdr(path)
    const second = await hdr(path)
    if (second === 'HIT') throw new Error(`brust sanity ${probe}: ${path} answered HIT on the second request — bypass: 'query(nocache)' is not in effect`)
  }
}

/** Copy the 0.1.x app + data into the 0.1.x checkout, where its relative imports resolve. */
export function prepare01x(dir: string): string {
  const dst = join(dir, 'bench/apps/m3-01x')
  mkdirSync(dst, { recursive: true })
  cpSync(join(ROOT, 'bench/apps/brust-01x'), dst, { recursive: true, force: true })
  cpSync(join(ROOT, 'bench/apps/_shared/data.json'), join(dst, 'data.json'), { force: true })
  return dst
}

const brust: AppSpec = {
  id: 'brust', label: 'brust v2', cwd: join(ROOT, 'bench/apps/brust'), port: P(1),
  available: () => ({ ok: true }),
  build: async (log) => sh([BRUST_BIN, 'build', 'routes.tsx'], join(ROOT, 'bench/apps/brust'), log),
  startCmd: () => ({ cmd: [BRUST_BIN, 'start', '--port', String(P(1)), '--workers', workers()], env: { BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', RUST_LOG: 'warn' } }),
  ready: /\[brust\] ready/,
  version: async () => `${(await Bun.file(join(ROOT, 'packages/brust/package.json')).json()).version} @ ${out(['git', 'rev-parse', '--short', 'HEAD'])}`,
  sanity: brustSanity,
}

const bunServe: AppSpec = {
  id: 'bun-serve', label: 'Bun.serve + renderToString', cwd: join(ROOT, 'bench/apps/bun-serve'), port: P(2),
  available: () => ({ ok: true }),
  build: async () => {},
  startCmd: () => ({ cmd: ['bun', 'index.ts'], env: { BENCH_PORT: String(P(2)), NODE_ENV: 'production' } }),
  ready: /\[bun-serve\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
  version: async () => Bun.version,
}

const next: AppSpec = {
  id: 'next', label: 'Next.js 16.4.0 (standalone, Node)', cwd: join(ROOT, 'bench/apps/next'), port: P(3),
  available: () => ({ ok: true }),
  build: async (log) => {
    const cwd = join(ROOT, 'bench/apps/next')
    sh(['bun', 'run', 'build'], cwd, log)
    const server = nextServerJs(cwd)
    cpSync(join(cwd, '.next/static'), join(server, '../.next/static'), { recursive: true, force: true })
  },
  startCmd: () => ({ cmd: ['node', nextServerJs(join(ROOT, 'bench/apps/next'))], env: { PORT: String(P(3)), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' } }),
  ready: /Ready in|Local:\s+http:\/\/\S+/,
  version: async () => (await Bun.file(join(ROOT, 'bench/apps/next/node_modules/next/package.json')).json()).version,
}

const brust01x: AppSpec = {
  id: 'brust-01x', label: 'brust 0.1.x', cwd: process.env.BRUST_01X_DIR ?? '', port: P(4),
  available: () => (process.env.BRUST_01X_DIR ? { ok: true } : { ok: false, reason: 'BRUST_01X_DIR unset' }),
  build: async (log) => {
    const dir = process.env.BRUST_01X_DIR!
    if (!existsSync(join(dir, 'runtime')) || !readdirSync(join(dir, 'runtime')).some((f) => f.endsWith('.node')))
      throw new Error(`0.1.x addon missing in ${dir}/runtime (cd runtime && bun run build)`)
    prepare01x(dir)
    sh(['bun', 'run', 'runtime/cli/index.ts', 'build', 'bench/apps/m3-01x/index.ts'], dir, log)
  },
  startCmd: () => ({ cmd: ['bun', 'run', 'bench/apps/m3-01x/index.ts'], env: { BRUST_PORT: String(P(4)), BRUST_WORKERS: workers(), RUST_LOG: 'brust=warn', NODE_ENV: 'production' }, cwd: process.env.BRUST_01X_DIR }),
  ready: /listening on 127\.0\.0\.1:(\d+)/,
  version: async () => (await Bun.file(join(process.env.BRUST_01X_DIR!, 'package.json')).json()).version,
}

export const APPS: Record<AppId, AppSpec> = { brust, 'bun-serve': bunServe, next, 'brust-01x': brust01x }
export const APP_ORDER: AppId[] = ['brust', 'bun-serve', 'next', 'brust-01x']
