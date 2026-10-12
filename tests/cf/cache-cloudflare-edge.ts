// cache-cloudflare Task 12 (R13): ONE real deploy of cf-cache (kvdo: a KV namespace + a Worker + the BrustCacheDO class), a worst-staleness measurement,
// then EVERYTHING deleted on every path (try/finally): a tombstone deploy that deletes the DO class, `wrangler delete`, the KV namespace, and probes.
// Human rule (bb rule:cloudflare-account): names `brust-test-<slug>-<shortsha>` only; no ids, URLs or account data in output, notes or files.
// Run by hand: `bun tests/cf/cache-cloudflare-edge.ts` (wrangler must be logged in; needs a built wasm in npm/core-cf/worker).
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WRANGLER } from './tools'

const REPO = resolve(import.meta.dir, '../..')
const APP = join(REPO, 'tests/fixtures/cf-cache')
const OUT = join(APP, 'dist-edge')
const CF = join(OUT, 'cf')
const sha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: REPO }).stdout.toString().trim()
const N = `brust-test-cache-cloudflare-${sha}`
const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }
const DEPLOY = join(CF, 'wrangler.deploy.jsonc')
const TOMB = join(CF, 'wrangler.tombstone.jsonc')

// Output of wrangler is captured and never echoed: it carries ids and URLs.
const wr = (args: string[], cwd = tmpdir()) => {
  console.log(`[edge] wrangler ${args.filter((a) => a !== '-c' && !a.endsWith('.jsonc') && !/^[0-9a-f]{32}$/.test(a)).join(' ')}`)
  const r = Bun.spawnSync(['bunx', WRANGLER, ...args], { cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

let failed = false
let kvId: string | undefined
let deployed = false
const times: number[] = []
try {
  const created = wr(['kv', 'namespace', 'create', N])
  if (created.code !== 0) throw new Error(`kv namespace create exited ${created.code}`)
  kvId = /\b([0-9a-f]{32})\b/.exec(created.out)?.[1]
  if (!kvId) throw new Error('could not read the namespace id (not printed)')

  // The 1 s interval of the plan; the committed brust.kvdo.toml uses 250 ms for the local suite.
  writeFileSync(join(APP, 'brust.toml'), readFileSync(join(APP, 'brust.kvdo.toml'), 'utf8').replace('epoch_interval_ms = 250', 'epoch_interval_ms = 1000'))
  const build = Bun.spawnSync([process.execPath, join(REPO, 'packages/brust/src/cli.ts'), 'build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', OUT], {
    cwd: APP,
    env: { ...process.env, BRUST_CORE_CF_DIR: join(REPO, 'npm/core-cf') },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (build.exitCode !== 0) throw new Error(`build exited ${build.exitCode}`)
  const cfg = Bun.JSONC.parse(readFileSync(join(CF, 'wrangler.jsonc'), 'utf8')) as Record<string, any>
  cfg.name = N
  cfg.kv_namespaces = [{ binding: 'BRUST_CACHE', id: kvId }]
  cfg.vars = {}
  writeFileSync(DEPLOY, JSON.stringify(cfg, null, 2))

  const dep = wr(['deploy', '-c', DEPLOY], CF)
  deployed = true // even a failed deploy may have created the Worker: the finally block deletes either way
  if (dep.code !== 0) throw new Error(`deploy exited ${dep.code}`)
  const base = /https:\/\/[^\s]+\.workers\.dev/.exec(dep.out)?.[0]
  if (!base) throw new Error('could not find the workers.dev URL (not printed)')

  const body = async (path: string, init?: RequestInit) => {
    const r = await fetch(base + path, { redirect: 'manual', ...init })
    return { status: r.status, text: await r.text() }
  }
  const rOf = (html: string) => Number(/class="r">(\d+)</.exec(html)?.[1])
  let ok = false
  for (let i = 0; i < 30 && !ok; i++) {
    ok = await body('/items/7').then((r) => r.status === 200, () => false)
    if (!ok) await Bun.sleep(2000)
  }
  if (!ok) throw new Error('the Worker never answered 200')
  for (let trial = 0; trial < 20; trial++) {
    const warm = rOf((await body('/items/7')).text)
    await body('/items/7')
    await Bun.sleep(1500) // let the write-through land
    const t0 = Date.now()
    const bump = await body('/_brust/action/bump', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ tag: 'items' }) })
    if (bump.status !== 200) throw new Error(`bump -> ${bump.status}`)
    for (;;) {
      if (rOf((await body('/items/7')).text) !== warm) break
      if (Date.now() - t0 > 30_000) {
        failed = true
        break
      }
      await Bun.sleep(100)
    }
    times.push(Date.now() - t0)
  }
} catch (e) {
  failed = true
  console.log(`[edge] FAILED: ${(e as Error).message}`)
} finally {
  if (deployed) {
    // The DO class is deleted explicitly: `wrangler delete` does not name Durable Objects.
    const tomb = Bun.JSONC.parse(readFileSync(DEPLOY, 'utf8')) as Record<string, any>
    tomb.main = 'worker/index.js'
    delete tomb.durable_objects
    delete tomb.kv_namespaces
    tomb.migrations = [...tomb.migrations, { tag: 'brust-cache-delete', deleted_classes: ['BrustCacheDO'] }]
    writeFileSync(TOMB, JSON.stringify(tomb, null, 2))
    const t = wr(['deploy', '-c', TOMB], CF)
    console.log(`[edge] tombstone deploy exit=${t.code}`)
    if (t.code !== 0) failed = true
    const a = wr(['delete', '--name', N, '--force'])
    console.log(`[edge] delete worker exit=${a.code}`)
    if (a.code !== 0) failed = true
  }
  if (kvId) {
    const b = wr(['kv', 'namespace', 'delete', '--namespace-id', kvId, '--skip-confirmation'])
    console.log(`[edge] delete kv exit=${b.code}`)
    if (b.code !== 0) failed = true
  }
  rmSync(DEPLOY, { force: true })
  rmSync(TOMB, { force: true })
  rmSync(OUT, { recursive: true, force: true })
  rmSync(join(APP, 'brust.toml'), { force: true })
  const l = wr(['deployments', 'list', '--name', N])
  const k = wr(['kv', 'namespace', 'list'])
  const leftover = (k.out.match(new RegExp(N, 'g')) ?? []).length
  console.log(`[edge] post-delete: deployments list exit=${l.code} (must be non-zero), kv namespaces named ${N}: ${leftover} (must be 0)`)
  if (l.code === 0 || leftover > 0) {
    console.log('[edge] something still exists: deleting again')
    wr(['delete', '--name', N, '--force'])
    if (kvId) wr(['kv', 'namespace', 'delete', '--namespace-id', kvId, '--skip-confirmation'])
    failed = true
  }
}
const sorted = [...times].sort((a, b) => a - b)
console.log(`[edge] name=${N} staleness ms: n=${sorted.length} min=${sorted[0] ?? '-'} median=${sorted[Math.floor(sorted.length / 2)] ?? '-'} max=${sorted.at(-1) ?? '-'} ${failed ? 'FAILED' : 'ok'}`)
process.exit(failed ? 1 : 0)
