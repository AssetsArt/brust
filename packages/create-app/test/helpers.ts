// Scaffold-test harness: pack the three workspace packages, build a host that has the PACKED create-app installed,
// and start scaffolded apps the way a user would (`bun run start`). Tarballs are the published shape (R8).
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO = join(import.meta.dir, '../../..')

export function sh(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(cmd, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', ...env } })
  const out = r.stdout.toString() + r.stderr.toString()
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} (cwd ${cwd}) exited ${r.exitCode}:\n${out}`)
  return out
}

function pack(pkgDir: string, dest: string): string {
  mkdirSync(dest, { recursive: true })
  const before = new Set(readdirSync(dest))
  sh(['bun', 'pm', 'pack', '--destination', dest], pkgDir)
  const made = readdirSync(dest).filter((f) => f.endsWith('.tgz') && !before.has(f))
  if (made.length !== 1) throw new Error(`expected one new tarball in ${dest}, got ${made.join(',')}`)
  return join(dest, made[0]!)
}

export function packAll(work: string): { createApp: string; core: string; runtimeDom: string } {
  const dest = join(work, 'packs')
  return {
    createApp: pack(join(REPO, 'packages/create-app'), dest),
    core: pack(join(REPO, 'packages/brust'), dest),
    runtimeDom: pack(join(REPO, 'packages/runtime-dom'), dest),
  }
}

/** A built @brust/core-cf package dir: $BRUST_CORE_CF_DIR if it holds worker/index_bg.wasm, else the repo's npm/core-cf, else null (no wasm built → the cloudflare case skips). */
export function coreCfSource(): string | null {
  const wasm = (d: string) => existsSync(join(d, 'worker/index_bg.wasm'))
  const env = process.env.BRUST_CORE_CF_DIR
  if (env && wasm(env)) return env
  const repo = join(REPO, 'npm/core-cf')
  return wasm(repo) ? repo : null
}

/** Pack `src` (package.json, README.md if any, worker/) as the published shape; returns the tarball path. */
export function packCoreCf(work: string, src: string): string {
  const dir = join(work, 'core-cf-pkg')
  mkdirSync(dir, { recursive: true })
  for (const f of ['package.json', 'README.md', 'worker']) if (existsSync(join(src, f))) cpSync(join(src, f), join(dir, f), { recursive: true })
  return pack(dir, join(work, 'packs'))
}

/** The host platform's native package as a directory: npm/<plat>/package.json + the built addon. */
export function hostNative(work: string): { name: string; dir: string } {
  const nodes = readdirSync(join(REPO, 'packages/brust/native')).filter((f) => /^brust\..+\.node$/.test(f))
  if (nodes.length !== 1) throw new Error('build the addon first: cd packages/brust && bun run build:debug')
  const plat = nodes[0]!.slice('brust.'.length, -'.node'.length)
  const dir = join(work, `native-${plat}`)
  mkdirSync(dir, { recursive: true })
  cpSync(join(REPO, 'npm', plat, 'package.json'), join(dir, 'package.json'))
  cpSync(join(REPO, 'packages/brust/native', nodes[0]!), join(dir, nodes[0]!))
  return { name: `@brust/native-${plat}`, dir }
}

/** A host dir with the packed @brust/create-app installed, so `bun create @brust/app` resolves its bin. */
export function host(work: string, createAppTgz: string): string {
  const dir = join(work, 'host')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { '@brust/create-app': `file:${createAppTgz}` } }))
  sh(['bun', 'install'], dir)
  return dir
}

export interface Running { base: string; stop: () => Promise<void> }

/** `bun run start --port 0 --workers 2` in the scaffolded app; resolves once `[brust] ready` is printed. */
export async function startApp(dir: string, env: Record<string, string> = {}): Promise<Running> {
  const proc = Bun.spawn(['bun', 'run', 'start', '--port', '0', '--workers', '2'], {
    cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
    env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', ...env },
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`bun run start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  const base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  return {
    base,
    stop: async () => {
      proc.kill('SIGINT')
      if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
    },
  }
}

export const exists = existsSync
