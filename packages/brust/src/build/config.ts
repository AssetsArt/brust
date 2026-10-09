// Build-time settings from `brust.toml` `[build]` (the runtime sections are `../config.ts`):
//   [build]
//   server_only = ["lib/server", "@acme/db"]   # import prefixes / app-root-relative paths
// `server_only` is the app config `serverOnly` of the compiler spec (§8.2): the compiler refuses
// such an import in client code, and every browser bundle refuses to include it.
import { join } from 'node:path'
import { BuildError } from './errors'

export interface BuildConfig {
  serverOnly: string[]
}

export async function loadBuildConfig(appRoot: string): Promise<BuildConfig> {
  const file = join(appRoot, 'brust.toml')
  const f = Bun.file(file)
  if (!(await f.exists())) return { serverOnly: [] }
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(await f.text())
  } catch (e) {
    throw new BuildError('config', `failed to parse ${file}: ${(e as Error).message}`)
  }
  const build = (parsed as Record<string, unknown>)?.build
  if (build === undefined) return { serverOnly: [] }
  if (build === null || typeof build !== 'object' || Array.isArray(build)) throw new BuildError('config', `${file}: [build] must be a table`)
  const so = (build as Record<string, unknown>).server_only
  if (so === undefined) return { serverOnly: [] }
  if (!Array.isArray(so) || so.some((p) => typeof p !== 'string' || p.trim() === ''))
    throw new BuildError('config', `${file}: build.server_only must be an array of non-empty strings`)
  return { serverOnly: so.map((p: string) => p.trim().replace(/^\.\//, '')) }
}
