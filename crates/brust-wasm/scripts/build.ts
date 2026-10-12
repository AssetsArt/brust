// Package the brust Workers host: `bun crates/brust-wasm/scripts/build.ts [--dev] [--e2e] [--out <dir>]`
// (default --out npm/core-cf/worker). worker-build 0.8.7 with --panic-unwind on the pinned nightly
// (scripts/pinned-bin rewrites its `cargo +nightly`, R8), then the R1 rewrite of the sentinel
// `cloudflare:brust-app` import specifiers to `./brust-app.js` (the wasm imports-object key keeps the
// sentinel: index_bg.wasm names it), then index.js, index_bg.wasm and worker/shim.mjs into --out.
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const crate = resolve(import.meta.dir, '..')
const root = resolve(crate, '../..')
const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const outArg = args.indexOf('--out')
const out = resolve(outArg >= 0 ? args[outArg + 1] : join(root, 'npm/core-cf/worker'))
const MAX_WASM = 4 * 1024 * 1024
const SENTINEL = 'cloudflare:brust-app'
const SPECIFIER = /from\s*"cloudflare:brust-app"/g
const KEY = /"cloudflare:brust-app"\s*:/g

const fail = (m: string): never => {
  console.error(`brust-wasm build: ${m}`)
  process.exit(1)
}

const env = { ...process.env, PATH: `${join(crate, 'scripts/pinned-bin')}:${process.env.PATH}` }
if (flag('--e2e')) env.BRUST_WASM_E2E = '1'
const wb = Bun.spawnSync(['worker-build', flag('--dev') ? '--dev' : '--release', '--panic-unwind'], {
  cwd: crate,
  env,
  stdout: 'inherit',
  stderr: 'pipe',
})
const stderr = wb.stderr.toString()
process.stderr.write(stderr)
if (wb.exitCode !== 0) fail(`worker-build exited ${wb.exitCode}`)
if (!stderr.includes('[pinned] +nightly -> +')) fail('worker-build did not go through scripts/pinned-bin (no [pinned] line)')

const build = join(crate, 'build')
const glue = readFileSync(join(build, 'index.js'), 'utf8')
const specifiers = glue.match(SPECIFIER)?.length ?? 0
const keys = glue.match(KEY)?.length ?? 0
if (specifiers < 1) fail(`no import of "${SENTINEL}" in build/index.js`)
const rewritten = glue.replace(SPECIFIER, 'from"./brust-app.js"')
if ((rewritten.match(SPECIFIER)?.length ?? 0) !== 0) fail('sentinel import specifiers left after the rewrite')
if ((rewritten.match(KEY)?.length ?? 0) !== keys) fail('the wasm imports-object key changed')

mkdirSync(join(out, 'worker'), { recursive: true })
writeFileSync(join(out, 'index.js'), rewritten)
copyFileSync(join(build, 'index_bg.wasm'), join(out, 'index_bg.wasm'))
copyFileSync(join(build, 'worker/shim.mjs'), join(out, 'worker/shim.mjs'))

const wasm = readFileSync(join(out, 'index_bg.wasm'))
const raw = statSync(join(out, 'index_bg.wasm')).size
console.log(`wasm raw=${raw} gzip=${gzipSync(wasm).length} (rewrote ${specifiers} import specifier(s); key kept x${keys}) -> ${out}`)
if (raw >= MAX_WASM) fail(`index_bg.wasm is ${raw} bytes (>= 4 MiB, R9)`)

