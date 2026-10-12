// Locates `@brust/core-cf` (the wasm core + glue, built by lane M4-CF-3) and reads its `brust` metadata (M4-CF R3, R4).
// Order: `--wasm-from-source` > env BRUST_CORE_CF_DIR > the app's node_modules > next to @brust/core.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BuildError } from './errors'

export interface CoreCfMeta {
  abi: number
  /** worker-build entry, relative to `worker/` */
  main: string
  glue: string
  /** dir under `worker/` that holds `brust-app.js` (next to the glue's `raw_module`) */
  appModuleDir: string
  compatibilityDate: string
}

export interface CoreCf {
  dir: string
  workerDir: string
  meta: CoreCfMeta
  version: string
  warnings: string[]
}

export interface ResolveOpts {
  appRoot: string
  fromSource: boolean
  env: Record<string, string | undefined>
  /** `@brust/core`'s package dir (default: this package) */
  corePkgDir?: string
  run?: (cmd: string[], cwd: string) => number
  which?: (bin: string) => string | null
}

const HINT = (v: string) => `install it with \`bun add -d @brust/core-cf@${v}\` or pass --wasm-from-source`

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function fromDir(dir: string, coreVersion: string): CoreCf {
  const pkg = readJson(join(dir, 'package.json'))
  const m = pkg?.brust as Partial<CoreCfMeta> | undefined
  if (!pkg || !m) throw new BuildError('cf-wasm', `${dir}/package.json has no "brust" metadata (not a @brust/core-cf package?)`)
  if (m.abi !== 1) throw new BuildError('cf-wasm', `@brust/core-cf has abi ${String(m.abi)}; this brust supports abi 1 — upgrade brust or core-cf`)
  const meta: CoreCfMeta = {
    abi: 1,
    main: m.main ?? 'index.js',
    glue: m.glue ?? m.main ?? 'index.js',
    appModuleDir: m.appModuleDir ?? '.',
    compatibilityDate: m.compatibilityDate ?? '2026-10-01',
  }
  const workerDir = join(dir, 'worker')
  if (!existsSync(join(workerDir, meta.main)))
    throw new BuildError('cf-wasm', `@brust/core-cf has no worker/${meta.main} (${dir}); ${HINT(coreVersion)}`)
  const version = String(pkg.version ?? '')
  const warnings: string[] = []
  if (version !== coreVersion) warnings.push(`[brust] @brust/core-cf ${version} differs from @brust/core ${coreVersion}`)
  return { dir, workerDir, meta, version, warnings }
}

export function resolveCoreCf(o: ResolveOpts): CoreCf {
  const corePkgDir = o.corePkgDir ?? join(import.meta.dir, '..', '..')
  const coreVersion = String(readJson(join(corePkgDir, 'package.json'))?.version ?? '0.0.0')
  if (o.fromSource) {
    const repo = join(corePkgDir, '..', '..')
    if (!existsSync(join(repo, 'crates', 'brust-wasm'))) throw new BuildError('cf-wasm', 'cf-wasm needs crates/brust-wasm (lane M4-CF-3): --wasm-from-source requires a brust checkout')
    const which = o.which ?? ((b: string) => Bun.which(b))
    for (const bin of ['cargo']) if (!which(bin)) throw new BuildError('cf-wasm', `--wasm-from-source needs \`${bin}\` on PATH`)
    const run = o.run ?? ((cmd, cwd) => Bun.spawnSync(cmd, { cwd, stdio: ['inherit', 'inherit', 'inherit'] }).exitCode)
    // The build script writes npm/core-cf/worker/ (lane 3 owns it; never bare `worker-build`).
    const code = run(['bun', join('crates', 'brust-wasm', 'scripts', 'build.ts')], repo)
    if (code !== 0) throw new BuildError('cf-wasm', `crates/brust-wasm/scripts/build.ts failed (exit ${code})`)
    return fromDir(join(repo, 'npm', 'core-cf'), coreVersion)
  }
  const envDir = o.env.BRUST_CORE_CF_DIR
  if (envDir) return fromDir(envDir, coreVersion)
  for (const from of [o.appRoot, corePkgDir]) {
    try {
      return fromDir(dirname(Bun.resolveSync('@brust/core-cf/package.json', from)), coreVersion)
    } catch (e) {
      if (e instanceof BuildError) throw e
    }
  }
  throw new BuildError('cf-wasm', `@brust/core-cf is not installed; ${HINT(coreVersion)}`)
}
