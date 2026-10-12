// M4-CF-5 Task 12: ONE real D1 + Worker deploy of the pokedex, curled, then deleted — on every path (try/finally).
// Human rule (bb rule:cloudflare-account): names `brust-test-<slug>-<shortsha>` only; delete everything; no ids, URLs or
// account data in output, notes or files. Run by hand: `bun tests/cf/pokedex-d1-edge.ts` (wrangler must be logged in).
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WRANGLER } from './tools'

const REPO = resolve(import.meta.dir, '../..')
const APP = join(REPO, 'examples/pokedex')
const CF = join(APP, 'dist/cf')
const sha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: REPO }).stdout.toString().trim()
const N = `brust-test-m4cf-pokedex-d1-${sha}`
const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }
const DEPLOY_CFG = join(CF, 'wrangler.deploy.jsonc')

// Output of wrangler is captured and never echoed: it carries ids and URLs.
const wr = (args: string[], cwd = tmpdir()) => {
  console.log(`[edge] wrangler ${args.filter((a) => a !== '-c' && !a.endsWith('.jsonc')).join(' ')}`)
  const r = Bun.spawnSync(['bunx', WRANGLER, ...args], { cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}
const sc = (url: string, init?: RequestInit) => fetch(url, { redirect: 'manual', ...init }).then((r) => r.status)

let failed = false
try {
  const created = wr(['d1', 'create', N])
  if (created.code !== 0) throw new Error(`d1 create exited ${created.code}`)
  const id = /database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i.exec(created.out)?.[1]
  if (!id) throw new Error('could not read the database id from d1 create (not printed)')

  const build = Bun.spawnSync([process.execPath, join(REPO, 'packages/brust/src/cli.ts'), 'build', 'routes.tsx', '--target', 'cloudflare'], {
    cwd: APP,
    env: { ...process.env, BRUST_CORE_CF_DIR: join(REPO, 'npm/core-cf') },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (build.exitCode !== 0) throw new Error(`build exited ${build.exitCode}`)
  const cfg = Bun.JSONC.parse(readFileSync(join(CF, 'wrangler.jsonc'), 'utf8')) as Record<string, unknown> & { d1_databases: Record<string, unknown>[] }
  cfg.name = N
  cfg.d1_databases = [{ ...cfg.d1_databases[0], database_name: N, database_id: id }]
  writeFileSync(DEPLOY_CFG, JSON.stringify(cfg, null, 2)) // dist/ is gitignored; removed in finally

  const mig = wr(['d1', 'migrations', 'apply', N, '--remote', '-c', DEPLOY_CFG], CF)
  if (mig.code !== 0) throw new Error(`migrations apply exited ${mig.code}`)
  const dep = wr(['deploy', '-c', DEPLOY_CFG], CF)
  if (dep.code !== 0) throw new Error(`deploy exited ${dep.code}`)
  const base = /https:\/\/[^\s]+\.workers\.dev/.exec(dep.out)?.[0]
  if (!base) throw new Error('could not find the workers.dev URL (not printed)')

  const status = async (label: string, path: string, want: number, init?: RequestInit) => {
    let got = 0
    for (let i = 0; i < 30; i++) {
      got = await sc(base + path, init).catch(() => 0)
      if (got === want) break
      await Bun.sleep(2000)
    }
    console.log(`[edge] ${label}: ${got}${got === want ? '' : ` (wanted ${want})`}`)
    if (got !== want) failed = true
  }
  const post = (id: number, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id }) })
  await status('GET /', '/', 200)
  await status('GET /pokemon/pikachu', '/pokemon/pikachu', 200)
  await status('GET /_brust/action/team', '/_brust/action/team', 200)
  const team = async () => ((await (await fetch(`${base}/_brust/action/team`)).json()) as { team: { id: number }[] }).team.map((m) => m.id)
  console.log(`[edge] team before: ${JSON.stringify(await team())}`)
  await status('POST /team {id:25}', '/_brust/action/team', 200, post(25))
  console.log(`[edge] team after: ${JSON.stringify(await team())}`)
  await status('POST evil origin', '/_brust/action/team', 403, post(4, { origin: 'https://evil.example' }))
  if (JSON.stringify(await team()) !== '[25]') {
    console.log('[edge] team is not [25]')
    failed = true
  }
} catch (e) {
  failed = true
  console.log(`[edge] FAILED: ${(e as Error).message}`)
} finally {
  const a = wr(['delete', N, '--force'])
  const b = wr(['d1', 'delete', N, '--skip-confirmation'])
  rmSync(DEPLOY_CFG, { force: true })
  console.log(`[edge] delete worker exit=${a.code}, delete d1 exit=${b.code}`)
  const l = wr(['deployments', 'list', '--name', N])
  const i = wr(['d1', 'info', N])
  console.log(`[edge] post-delete: deployments list exit=${l.code}, d1 info exit=${i.code} (both must be non-zero)`)
  if (l.code === 0 || i.code === 0) {
    console.log('[edge] something still exists: deleting again')
    wr(['delete', N, '--force'])
    wr(['d1', 'delete', N, '--skip-confirmation'])
    failed = true
  }
}
console.log(`[edge] name=${N} ${failed ? 'FAILED' : 'ok'}`)
process.exit(failed ? 1 : 0)
