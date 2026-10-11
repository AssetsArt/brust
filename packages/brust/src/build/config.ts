// Build-time settings from `brust.toml` `[build]` (the runtime sections are `../config.ts`):
//   [build]
//   server_only = ["lib/server", "@acme/db"]   # import prefixes / app-root-relative paths
// `server_only` is the app config `serverOnly` of the compiler spec (§8.2): the compiler refuses
// such an import in client code, and every browser bundle refuses to include it.
import { join } from 'node:path'
import { DEFAULT_ACTION_PREFIX, DEFAULT_MAX_BODY_BYTES, prefixError } from '../actions/prefix'
import { BuildError } from './errors'

// [actions] (opt-in, ruling R6): present table => actions on. Crosses napi as u32.
//   [actions]
//   entry = "actions.ts"   prefix = "/_brust/action"   max_body_bytes = 262144
const MAX_U32 = 0xffff_ffff

export interface ActionsBuildConfig {
  entry: string
  prefix: string
  maxBodyBytes: number
}

export interface BuildConfig {
  serverOnly: string[]
  actions: ActionsBuildConfig | null
}

function parseActions(file: string, raw: unknown): ActionsBuildConfig | null {
  if (raw === undefined) return null
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BuildError('config', `${file}: [actions] must be a table`)
  const t = raw as Record<string, unknown>
  let entry = DEFAULT_ENTRY
  if (t.entry !== undefined) {
    if (typeof t.entry !== 'string' || t.entry.trim() === '') throw new BuildError('config', `${file}: actions.entry must be a non-empty string`)
    entry = t.entry.trim().replace(/^\.\//, '')
  }
  let prefix = DEFAULT_ACTION_PREFIX
  if (t.prefix !== undefined) {
    const why = prefixError(t.prefix)
    if (why) throw new BuildError('config', `${file}: actions.prefix ${why}`)
    prefix = t.prefix as string
  }
  let maxBodyBytes = DEFAULT_MAX_BODY_BYTES
  if (t.max_body_bytes !== undefined) {
    const n = t.max_body_bytes
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_U32)
      throw new BuildError('config', `${file}: actions.max_body_bytes must be an integer in 1..${MAX_U32} (got ${String(n)})`)
    maxBodyBytes = n
  }
  return { entry, prefix, maxBodyBytes }
}

const DEFAULT_ENTRY = 'actions.ts'

export async function loadBuildConfig(appRoot: string): Promise<BuildConfig> {
  const file = join(appRoot, 'brust.toml')
  const f = Bun.file(file)
  if (!(await f.exists())) return { serverOnly: [], actions: null }
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(await f.text())
  } catch (e) {
    throw new BuildError('config', `failed to parse ${file}: ${(e as Error).message}`)
  }
  const root = (parsed ?? {}) as Record<string, unknown>
  const actions = parseActions(file, root.actions)
  const build = root.build
  if (build === undefined) return { serverOnly: [], actions }
  if (build === null || typeof build !== 'object' || Array.isArray(build)) throw new BuildError('config', `${file}: [build] must be a table`)
  const so = (build as Record<string, unknown>).server_only
  if (so === undefined) return { serverOnly: [], actions }
  if (!Array.isArray(so) || so.some((p) => typeof p !== 'string' || p.trim() === ''))
    throw new BuildError('config', `${file}: build.server_only must be an array of non-empty strings`)
  return { serverOnly: so.map((p: string) => p.trim().replace(/^\.\//, '')), actions }
}
