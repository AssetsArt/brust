// Build cf-cache for Cloudflare: `bun scripts/build-cf.ts <kvdo|do>`. The e2e wasm (`build.ts --e2e`, skipped when BRUST_CF_WASM_READY=1) goes into
// npm/core-cf/worker, then `brust build --target cloudflare` runs against it with the variant's brust.<variant>.toml as brust.toml.
// Output: tests/fixtures/cf-cache/dist-<variant>/cf/{worker,assets,wrangler.jsonc}.
import { copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const variant = process.argv[2]
if (variant !== 'kvdo' && variant !== 'do') {
  console.error('usage: bun scripts/build-cf.ts <kvdo|do>')
  process.exit(1)
}
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
copyFileSync(join(app, `brust.${variant}.toml`), join(app, 'brust.toml'))
run([process.execPath, join(repo, 'packages/brust/src/cli.ts'), 'build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', join(app, `dist-${variant}`)], app, {
  BRUST_CORE_CF_DIR: join(repo, 'npm/core-cf'),
})
