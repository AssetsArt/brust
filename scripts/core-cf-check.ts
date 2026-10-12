#!/usr/bin/env bun
// scripts/core-cf-check.ts — gate for the @brust/core-cf package dir (M4-CF-6 R2/R3). Used by the ci `cf` job, release.yml dry-run and publish.
//   bun scripts/core-cf-check.ts <pkgDir> [--pack] [--versions <Cargo.toml>]
// Asserts: package.json shape (name, brust.abi 1, brust fields), worker/ holds exactly CORE_CF_WORKER_FILES, wasm raw < 4 MiB,
// no e2e build marker (an --e2e wasm must never be published), and with --pack the tarball holds only the allow-list.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

/** Pinned from crates/brust-wasm/scripts/build.ts's real output (relative to the package dir). */
export const CORE_CF_WORKER_FILES = ['worker/index.js', 'worker/index_bg.wasm', 'worker/worker/shim.mjs']
export const MAX_WASM_BYTES = 4 * 1024 * 1024
/** Present only in an `--e2e` wasm (the deliberate-panic route's message); absent from release builds (proven in M4-CF-6 Task 1). */
export const E2E_MARKER = 'brust e2e: deliberate panic'
const BRUST_FIELDS = ['main', 'glue', 'appModuleDir', 'compatibilityDate', 'workerBuild'] as const

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split('\\').join('/')]))
}

export function checkPackage(dir: string): { errors: string[]; info: string[] } {
  const errors: string[] = []; const info: string[] = []
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) return { errors: [`${pj}: missing`], info }
  const pkg = JSON.parse(readFileSync(pj, 'utf8'))
  if (pkg.name !== '@brust/core-cf') errors.push(`package.json name is "${pkg.name}", expected @brust/core-cf`)
  if (pkg.brust?.abi !== 1) errors.push(`package.json brust.abi is ${JSON.stringify(pkg.brust?.abi)}, expected 1`)
  for (const k of BRUST_FIELDS) if (typeof pkg.brust?.[k] !== 'string' || !pkg.brust[k]) errors.push(`package.json brust.${k} missing`)
  const wdir = join(dir, 'worker')
  const have = existsSync(wdir) ? walk(dir, dir).filter((f) => f.startsWith('worker/')).sort() : []
  for (const f of CORE_CF_WORKER_FILES) if (!have.includes(f)) errors.push(`${f}: missing from the package`)
  for (const f of have) if (!CORE_CF_WORKER_FILES.includes(f)) errors.push(`${f}: unexpected file (allow-list: ${CORE_CF_WORKER_FILES.join(', ')})`)
  for (const k of ['main', 'glue'] as const) if (pkg.brust?.[k] && !have.includes(`worker/${pkg.brust[k]}`)) errors.push(`brust.${k} "${pkg.brust[k]}" has no worker/${pkg.brust[k]}`)
  const wasm = join(dir, 'worker/index_bg.wasm')
  if (existsSync(wasm)) {
    const bytes = readFileSync(wasm); const raw = statSync(wasm).size
    info.push(`core-cf wasm raw=${raw} gzip=${gzipSync(bytes).length}`)
    if (raw >= MAX_WASM_BYTES) errors.push(`index_bg.wasm raw ${raw} ≥ ${MAX_WASM_BYTES} (4 MiB cap)`)
    if (bytes.includes(E2E_MARKER)) errors.push(`index_bg.wasm carries "${E2E_MARKER}": e2e build, never publish`)
  }
  const glue = join(dir, 'worker/index.js')
  if (existsSync(glue) && readFileSync(glue, 'utf8').includes('__brust_e2e')) errors.push('worker/index.js references __brust_e2e: e2e build, never publish')
  return { errors, info }
}

/** R3: worker = "=X" in Cargo.toml must equal package.json brust.workerBuild. */
export function checkVersions(dir: string, cargoToml: string): string[] {
  const wb = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).brust?.workerBuild
  const m = readFileSync(cargoToml, 'utf8').match(/^worker\s*=\s*"=([^"]+)"/m)
  if (!m) return [`${cargoToml}: no pinned \`worker = "=<v>"\` line`]
  return m[1] === wb ? [] : [`worker-build ${wb} ≠ worker =${m[1]} (${cargoToml})`]
}

/** Tarball listing (npm layout: every entry under `package/`) must equal the allow-list; README.md is optional (npm/core-cf has none yet). */
export function checkPack(dir: string): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'core-cf-pack-'))
  try {
    const p = Bun.spawnSync(['bun', 'pm', 'pack', '--destination', tmp, '--quiet'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) return [`bun pm pack failed: ${p.stderr.toString().trim()}`]
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tgz) return ['bun pm pack produced no tarball']
    const t = Bun.spawnSync(['tar', '-tzf', join(tmp, tgz)], { stdout: 'pipe', stderr: 'pipe' })
    const listed = t.stdout.toString().split('\n').map((l) => l.trim()).filter((l) => l && !l.endsWith('/')).sort()
    const allowed = ['package/package.json', ...CORE_CF_WORKER_FILES.map((f) => `package/${f}`)]
    const errors: string[] = []
    for (const f of allowed) if (!listed.includes(f)) errors.push(`tarball lacks ${f}`)
    for (const f of listed) if (!allowed.includes(f) && f !== 'package/README.md') errors.push(`tarball has unexpected ${f}`)
    return errors
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const vi = args.indexOf('--versions'); const cargo = vi >= 0 ? args[vi + 1] : undefined
  const dir = args.find((a, i) => !a.startsWith('--') && (vi < 0 || i !== vi + 1))
  if (!dir || (vi >= 0 && !cargo)) { console.error('usage: bun scripts/core-cf-check.ts <pkgDir> [--pack] [--versions <Cargo.toml>]'); process.exit(1) }
  const abs = resolve(dir)
  const { errors, info } = checkPackage(abs)
  if (cargo) errors.push(...checkVersions(abs, resolve(cargo)))
  if (args.includes('--pack') && !errors.length) errors.push(...checkPack(abs))
  for (const l of info) console.log(l)
  if (errors.length) { for (const e of errors) console.error(`✗ ${e}`); process.exit(1) }
  console.log(`✓ core-cf ok${args.includes('--pack') ? ' (tarball checked)' : ''}`)
}
