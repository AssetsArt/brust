// Build cf-l2 for Cloudflare: the e2e wasm (`crates/brust-wasm/scripts/build.ts --e2e`, skipped when
// BRUST_CF_WASM_READY=1) into npm/core-cf/worker, then lane 4's `brust build --target cloudflare` against it.
// Output: tests/fixtures/cf-l2/dist/cf/{worker,assets,wrangler.jsonc}.
import { join, resolve } from 'node:path'

const app = resolve(import.meta.dir, '..')
const repo = resolve(app, '../../..')
const run = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) {
    console.error(`build-cf: ${cmd.join(' ')} exited ${r.exitCode}`)
    process.exit(1)
  }
}

if (process.env.BRUST_CF_WASM_READY !== '1') run(['bun', join(repo, 'crates/brust-wasm/scripts/build.ts'), '--e2e'], repo)
run([process.execPath, join(repo, 'packages/brust/src/cli.ts'), 'build', 'routes.tsx', '--target', 'cloudflare'], app, {
  BRUST_CORE_CF_DIR: join(repo, 'npm/core-cf'),
})
