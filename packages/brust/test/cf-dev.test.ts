import { afterAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const FIX = join(import.meta.dir, 'fixtures')
const cleanup: string[] = []
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

test('brust dev --target cloudflare builds, runs wrangler, rebuilds + restarts on change, exits 0 on SIGTERM', async () => {
  const app = join(FIX, 'cf-app-dev')
  cleanup.push(app)
  cpSync(join(FIX, 'cf-app'), app, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'brust-cfdev-'))
  cleanup.push(tmp)
  const fake = join(tmp, 'wrangler')
  const argsFile = join(tmp, 'args')
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${argsFile}"\nexec sleep 600\n`)
  chmodSync(fake, 0o755)
  const lines = () => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').filter(Boolean) : [])
  const p = Bun.spawn([process.execPath, CLI, 'dev', 'routes.tsx', '--target', 'cloudflare', '--out-dir', 'dist', '--', '--port', '0'], {
    cwd: app,
    env: { ...process.env, BRUST_CORE_CF_DIR: join(FIX, 'cf-core'), BRUST_WRANGLER: fake },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    const dist = join(app, 'dist')
    // realpath: the child resolves cwd (/private/var vs /var on macOS) — compare on the tail
    const want = (abs: string) => `dev -c ${abs}/dist/cf/wrangler.jsonc --persist-to ${abs}/.wrangler/state --port 0`
    await until(() => lines().length === 1, 'first wrangler spawn')
    expect(lines()[0]!.replace('/private', '')).toBe(want(app).replace('/private', ''))
    expect(existsSync(join(dist, 'cf', 'wrangler.jsonc'))).toBe(true)
    writeFileSync(join(app, 'Home.tsx'), `${readFileSync(join(app, 'Home.tsx'), 'utf8')}\n// touched\n`)
    await until(() => lines().length === 2, 'wrangler restart after a source change')
  } finally {
    p.kill('SIGTERM')
  }
  expect(await p.exited).toBe(0)
}, 120_000)

test('brust dev without --target is a usage error', () => {
  const r = Bun.spawnSync([process.execPath, CLI, 'dev', 'routes.tsx'], { cwd: join(FIX, 'cf-app'), stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode).toBe(2)
  expect(r.stderr.toString()).toContain('only --target cloudflare')
})
