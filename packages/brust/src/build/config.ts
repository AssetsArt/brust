// Build-time settings from `brust.toml` `[build]` (the runtime sections are `../config.ts`):
//   [build]
//   server_only = ["lib/server", "@acme/db"]   # import prefixes / app-root-relative paths
// `server_only` is the app config `serverOnly` of the compiler spec (§8.2): the compiler refuses
// such an import in client code, and every browser bundle refuses to include it.
import { join } from 'node:path'
import { DEFAULT_ACTION_PREFIX, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_RESPONSE_BYTES, MAX_ACTION_BYTES, prefixError } from '../actions/prefix'
import { BuildError } from './errors'

// [actions] (opt-in, ruling R6): present table => actions on. Both byte caps cross napi as u32 (F82: 1..64 MiB / 256 KiB..64 MiB).
//   [actions]
//   entry = "actions.ts"   prefix = "/_brust/action"   max_body_bytes = 1048576  max_response_bytes = 8388608   cross_site = "reject" | "allow" (F87)
const MIN_RESPONSE_BYTES = 262_144

export interface ActionsBuildConfig {
  entry: string
  prefix: string
  maxBodyBytes: number
  maxResponseBytes: number
  crossSite: 'reject' | 'allow'
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
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_ACTION_BYTES)
      throw new BuildError('config', `${file}: actions.max_body_bytes must be an integer in 1..${MAX_ACTION_BYTES} (got ${String(n)})`)
    maxBodyBytes = n
  }
  let maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
  if (t.max_response_bytes !== undefined) {
    const n = t.max_response_bytes
    if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_RESPONSE_BYTES || n > MAX_ACTION_BYTES)
      throw new BuildError('config', `${file}: actions.max_response_bytes must be an integer in ${MIN_RESPONSE_BYTES}..${MAX_ACTION_BYTES} (got ${String(n)})`)
    maxResponseBytes = n
  }
  let crossSite: 'reject' | 'allow' = 'reject'
  if (t.cross_site !== undefined) {
    if (t.cross_site !== 'reject' && t.cross_site !== 'allow') throw new BuildError('config', `${file}: actions.cross_site must be "reject" or "allow"`)
    crossSite = t.cross_site
  }
  return { entry, prefix, maxBodyBytes, maxResponseBytes, crossSite }
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
