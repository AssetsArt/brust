// Build-time settings from `brust.toml` `[build]` (the runtime sections are `../config.ts`):
//   [build]
//   server_only = ["lib/server", "@acme/db"]   # import prefixes / app-root-relative paths
//   source_roots = ["../shared"]                # F256: directories besides the app a relative import may reach (monorepo)
// `server_only` is the app config `serverOnly` of the compiler spec (§8.2): the compiler refuses
// such an import in client code, and every browser bundle refuses to include it.
import { statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  ACTION_CREDENTIALS,
  type ActionCredentials,
  DEFAULT_ACTION_PREFIX,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_STREAM_BYTES,
  DEFAULT_STREAM_IDLE_MS,
  DEFAULT_STREAM_TOTAL_MS,
  MAX_ACTION_BYTES,
  MAX_STREAM_BYTES,
  baseUrlError,
  prefixError,
  streamEntryError,
} from '../actions/prefix'
import { ADAPTER_NAMES, BUILTINS, installHint } from '../cache-adapter/load'
import { BuildError } from './errors'

// [actions] (opt-in, ruling R6): present table => actions on. Both byte caps cross napi as u32 (F82: 1..64 MiB / 256 KiB..64 MiB).
//   [actions]
//   entry = "actions.ts"   prefix = "/_brust/action"   max_body_bytes = 1048576  max_response_bytes = 8388608   cross_site = "reject" | "allow" (F87)
//   base_url = "https://api.example.com"  credentials = "same-origin" | "include" | "omit"   (L16: the browser client's target; runtime settings, validated here too)
// `prefix = "/"` is accepted only for an actions-only build (L16 R16.4).
// F475: stream = ["POST /upload", "PUT /files/*"] (relative to the prefix; each a `{ parse: 'none' }` route) streams those bodies
//   max_stream_bytes = 268435456 (<= 4294967296)  stream_idle_ms = 30000  stream_total_ms = 900000  max_streams = <workers x slots / 4>
// `ACTION_INLINE_BODY_BYTES` (Rust): the inline/heap threshold of an action body, independent of the response slot size (`slotBytes`).
const MIN_RESPONSE_BYTES = 262_144

export interface ActionsBuildConfig {
  entry: string
  prefix: string
  maxBodyBytes: number
  maxResponseBytes: number
  crossSite: 'reject' | 'allow'
  /** `[actions] base_url`; with no actions file present the build is page-only (L16 R16.4b). */
  baseUrl: string | undefined
  credentials: ActionCredentials
  /** `entry` was written in brust.toml (a missing file is then an error, never a page-only build). */
  entryExplicit: boolean
  /** F475: the streamed routes and their bounds; absent = no `stream` list (or an empty one). */
  stream?: ActionsStreamConfig
}

/** F475 `[actions] stream` and its bounds, as the manifest carries them. */
export interface ActionsStreamConfig {
  stream: string[]
  maxStreamBytes: number
  streamIdleMs: number
  streamTotalMs: number
  maxStreams?: number
}

// [cloudflare] (M4-CF; only read by `--target cloudflare`, validated always so errors surface early):
//   name = "my-worker"  compatibility_date = "2026-10-01"  l1_capacity = 256  job_cache_capacity = 512  stats = false
//   edge_cache = "off"  [cloudflare.alias]  "lib/db.ts" = "lib/db.cf.ts"   # app-root-relative module swaps (spec R12)
const CF_KEYS = new Set(['name', 'compatibility_date', 'l1_capacity', 'job_cache_capacity', 'stats', 'edge_cache', 'alias'])
export const CF_MIN_COMPAT_DATE = '2026-08-04'
const U32_MAX = 4_294_967_295

export interface CloudflareBuildConfig {
  name: string | undefined
  compatibilityDate: string | undefined
  l1Capacity: number
  jobCacheCapacity: number
  stats: boolean
  edgeCache: 'off'
  /** absolute module path -> absolute replacement path */
  alias: Record<string, string>
}

// [cache] (cache adapters, opt-in; spec §6): a shared second tier behind the in-process cache.
//   adapter = "redis" | "dragonfly" | "cloudflare-kv" | "cloudflare-do" | "custom"   module = "lib/cache.ts" (custom)
//   broadcast = "<built-in>"   namespace = "<package name>"   get_timeout_ms = 50 (native) / 100 (Workers)
//   max_body_bytes = 1048576   epoch_interval_ms = 1000   [cache.redis] url = "env:REDIS_URL"   [cache.cloudflare]   [cache.options]
const CACHE_KEYS = new Set(['adapter', 'broadcast', 'module', 'namespace', 'get_timeout_ms', 'max_body_bytes', 'epoch_interval_ms', 'redis', 'cloudflare', 'options'])
export const MAX_L2_BODY_BYTES = 67_108_864

export interface CacheBuildConfig {
  adapter: (typeof ADAPTER_NAMES)[number]
  /** `custom`: the module, app-root-relative as written. */
  module: string | undefined
  broadcast: string | undefined
  /** The factory's options: `[cache.redis]` / `[cache.cloudflare]` for built-ins, `[cache.options]` for custom. */
  options: Record<string, unknown>
  broadcastOptions: Record<string, unknown> | undefined
  namespace: string
  /** Absent = the runtime default (native 50, Workers 100). */
  getTimeoutMs: number | undefined
  maxBodyBytes: number
  epochIntervalMs: number
}

export interface BuildConfig {
  serverOnly: string[]
  actions: ActionsBuildConfig | null
  cloudflare: CloudflareBuildConfig | null
  cache: CacheBuildConfig | null
  /** `[css] global` (L19, R19.1): app-root-relative stylesheets every route links first, in order. */
  cssGlobal: string[]
  /** `[build] source_roots` (F256): directories outside the app a relative import may reach, normalised and relative to the app root (`../shared`). Empty = the app only. */
  sourceRoots: string[]
}

const isTable = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function rangeInt(file: string, key: string, v: unknown, lo: number, hi: number, dflt: number): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi)
    throw new BuildError('cache', `${file}: cache.${key} must be an integer in ${lo}..${hi} (got ${String(v)})`)
  return v
}

/** `[cache.redis]`'s keys and ranges (cache-redis R10); `@brust/cache-redis` validates the same list at worker boot. */
const REDIS_INT_KEYS: ReadonlyArray<readonly [string, number, number]> = [
  ['connect_timeout_ms', 100, 60_000],
  ['max_body_bytes', 1, MAX_L2_BODY_BYTES],
  ['marker_ttl_ms', 60_000, 604_800_000],
  ['unlink_batch', 1, 10_000],
  ['reconnect_min_ms', 10, 60_000],
  ['reconnect_max_ms', 10, 600_000],
]
const REDIS_TLS_KEYS: Record<string, string> = { reject_unauthorized: 'boolean', server_name: 'string', ca_file: 'string' }

function checkRedisTable(file: string, r: Record<string, unknown>): void {
  const known = new Set(['url', 'tls', ...REDIS_INT_KEYS.map(([k]) => k)])
  for (const k of Object.keys(r)) if (!known.has(k)) throw new BuildError('cache', `${file}: cache.redis.${k} is not a known key`)
  for (const [k, lo, hi] of REDIS_INT_KEYS) rangeInt(file, `redis.${k}`, r[k], lo, hi, lo)
  if (typeof r.reconnect_min_ms === 'number' && typeof r.reconnect_max_ms === 'number' && r.reconnect_max_ms < r.reconnect_min_ms)
    throw new BuildError('cache', `${file}: cache.redis.reconnect_max_ms must be >= cache.redis.reconnect_min_ms`)
  const tls = r.tls
  if (tls === undefined || typeof tls === 'boolean') return
  if (!isTable(tls)) throw new BuildError('cache', `${file}: cache.redis.tls must be a boolean or a table`)
  for (const [k, v] of Object.entries(tls)) {
    const want = REDIS_TLS_KEYS[k]
    if (!want) throw new BuildError('cache', `${file}: cache.redis.tls.${k} is not a known key`)
    if (typeof v !== want || v === '') throw new BuildError('cache', `${file}: cache.redis.tls.${k} must be a ${want === 'string' ? 'non-empty string' : want}`)
  }
}

/** The option table a built-in reads. */
function builtinOptions(name: string, t: Record<string, unknown>): Record<string, unknown> {
  const key = name === 'redis' || name === 'dragonfly' ? 'redis' : 'cloudflare'
  return { ...((t[key] as Record<string, unknown> | undefined) ?? {}) }
}

async function packageName(appRoot: string): Promise<string | undefined> {
  const f = Bun.file(join(appRoot, 'package.json'))
  if (!(await f.exists())) return undefined
  try {
    const n = ((await f.json()) as { name?: unknown }).name
    return typeof n === 'string' && n.trim() ? n.trim() : undefined
  } catch {
    return undefined
  }
}

async function parseCache(file: string, appRoot: string, raw: unknown): Promise<CacheBuildConfig | null> {
  if (raw === undefined) return null
  if (!isTable(raw)) throw new BuildError('cache', `${file}: [cache] must be a table`)
  const t = raw
  for (const k of Object.keys(t)) if (!CACHE_KEYS.has(k)) throw new BuildError('cache', `${file}: cache.${k} is not a known key`)
  for (const k of ['redis', 'cloudflare', 'options'] as const)
    if (t[k] !== undefined && !isTable(t[k])) throw new BuildError('cache', `${file}: [cache.${k}] must be a table`)
  const adapter = t.adapter
  if (typeof adapter !== 'string' || !(ADAPTER_NAMES as readonly string[]).includes(adapter))
    throw new BuildError('cache', `${file}: cache.adapter must be one of ${ADAPTER_NAMES.map((n) => `"${n}"`).join(', ')} (got ${JSON.stringify(adapter)})`)
  const name = adapter as CacheBuildConfig['adapter']
  let module: string | undefined
  if (name === 'custom') {
    if (typeof t.module !== 'string' || t.module.trim() === '') throw new BuildError('cache', `${file}: cache.module is required for adapter "custom"`)
    module = t.module.trim()
  } else if (t.module !== undefined) throw new BuildError('cache', `${file}: cache.module is only for adapter "custom"`)
  let broadcast: string | undefined
  if (t.broadcast !== undefined) {
    if (typeof t.broadcast !== 'string' || !(t.broadcast in BUILTINS))
      throw new BuildError('cache', `${file}: cache.broadcast must name a built-in adapter (${Object.keys(BUILTINS).map((n) => `"${n}"`).join(', ')})`)
    broadcast = t.broadcast
  }
  // `env:` indirection only: a literal URL may carry a password, so the error never echoes the value.
  const redis = t.redis as Record<string, unknown> | undefined
  if (redis?.url !== undefined && (typeof redis.url !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(redis.url)))
    throw new BuildError('cache', `${file}: cache.redis.url must be "env:NAME" (a literal URL is refused: it may hold a password)`)
  if (redis) checkRedisTable(file, redis)
  for (const n of [name, broadcast]) {
    if (n === undefined || n === 'custom') continue
    try {
      Bun.resolveSync(BUILTINS[n]!, appRoot)
    } catch {
      throw new BuildError('cache', `${file}: ${installHint(n)}`)
    }
  }
  const options = name === 'custom' ? { ...((t.options as Record<string, unknown> | undefined) ?? {}) } : builtinOptions(name, t)
  let namespace = (await packageName(appRoot)) ?? 'brust'
  if (t.namespace !== undefined) {
    if (typeof t.namespace !== 'string' || !/^[A-Za-z0-9@._/-]{1,64}$/.test(t.namespace))
      throw new BuildError('cache', `${file}: cache.namespace must be 1..64 of [A-Za-z0-9@._/-]`)
    namespace = t.namespace
  }
  return {
    adapter: name,
    module,
    broadcast,
    options,
    broadcastOptions: broadcast ? builtinOptions(broadcast, t) : undefined,
    namespace,
    getTimeoutMs: t.get_timeout_ms === undefined ? undefined : rangeInt(file, 'get_timeout_ms', t.get_timeout_ms, 1, 1000, 50),
    maxBodyBytes: rangeInt(file, 'max_body_bytes', t.max_body_bytes, 1, MAX_L2_BODY_BYTES, 1_048_576),
    epochIntervalMs: rangeInt(file, 'epoch_interval_ms', t.epoch_interval_ms, 250, 60_000, 1000),
  }
}

function cfCapacity(file: string, key: string, v: unknown, dflt: number): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > U32_MAX)
    throw new BuildError('config', `${file}: cloudflare.${key} must be an integer in 1..${U32_MAX} (got ${String(v)})`)
  return v
}

function parseCloudflare(file: string, appRoot: string, raw: unknown): CloudflareBuildConfig | null {
  if (raw === undefined) return null
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BuildError('config', `${file}: [cloudflare] must be a table`)
  const t = raw as Record<string, unknown>
  for (const k of Object.keys(t)) if (!CF_KEYS.has(k)) throw new BuildError('config', `${file}: cloudflare.${k} is not a known key`)
  if (t.name !== undefined && (typeof t.name !== 'string' || t.name.trim() === ''))
    throw new BuildError('config', `${file}: cloudflare.name must be a non-empty string`)
  let compatibilityDate: string | undefined
  if (t.compatibility_date !== undefined) {
    const d = t.compatibility_date
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BuildError('config', `${file}: cloudflare.compatibility_date must be YYYY-MM-DD`)
    if (d < CF_MIN_COMPAT_DATE)
      throw new BuildError('config', `${file}: cloudflare.compatibility_date must be >= ${CF_MIN_COMPAT_DATE} (nodejs_compat is default from then)`)
    compatibilityDate = d
  }
  if (t.stats !== undefined && typeof t.stats !== 'boolean') throw new BuildError('config', `${file}: cloudflare.stats must be a boolean`)
  if (t.edge_cache !== undefined) {
    if (t.edge_cache === 'workers-cache') throw new BuildError('config', `${file}: cloudflare.edge_cache = "workers-cache" lands with M4-CF-7`)
    if (t.edge_cache !== 'off') throw new BuildError('config', `${file}: cloudflare.edge_cache must be "off"`)
  }
  const alias: Record<string, string> = {}
  if (t.alias !== undefined) {
    if (t.alias === null || typeof t.alias !== 'object' || Array.isArray(t.alias))
      throw new BuildError('config', `${file}: cloudflare.alias must be a table of module paths`)
    for (const [from, to] of Object.entries(t.alias as Record<string, unknown>)) {
      if (typeof to !== 'string' || to.trim() === '') throw new BuildError('config', `${file}: cloudflare.alias["${from}"] must be a non-empty string`)
      alias[resolveAlias(file, appRoot, from)] = resolveAlias(file, appRoot, to)
    }
  }
  return {
    name: t.name === undefined ? undefined : (t.name as string).trim(),
    compatibilityDate,
    l1Capacity: cfCapacity(file, 'l1_capacity', t.l1_capacity, 256),
    jobCacheCapacity: cfCapacity(file, 'job_cache_capacity', t.job_cache_capacity, 512),
    stats: (t.stats as boolean | undefined) ?? false,
    edgeCache: 'off',
    alias,
  }
}

function resolveAlias(file: string, appRoot: string, p: string): string {
  const rel = p.trim().replace(/^\.\//, '')
  try {
    return Bun.resolveSync(`./${rel}`, appRoot)
  } catch {
    throw new BuildError('config', `${file}: cloudflare.alias: cannot resolve "${p}" from the app root`)
  }
}

function parseActions(file: string, raw: unknown, actionsOnly: boolean): ActionsBuildConfig | null {
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
    // `/` is the prefix of an actions-only deployment; a page-only build (base_url, no local app) may name it too.
    const why = prefixError(t.prefix, actionsOnly || t.base_url !== undefined)
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
  let baseUrl: string | undefined
  if (t.base_url !== undefined) {
    const why = baseUrlError(t.base_url)
    if (why) throw new BuildError('config', `${file}: actions.base_url ${why}`)
    baseUrl = t.base_url as string
  }
  let credentials: ActionCredentials = 'same-origin'
  if (t.credentials !== undefined) {
    if (typeof t.credentials !== 'string' || !ACTION_CREDENTIALS.includes(t.credentials as ActionCredentials))
      throw new BuildError('config', `${file}: actions.credentials must be one of ${ACTION_CREDENTIALS.join(', ')} (got ${JSON.stringify(t.credentials)})`)
    credentials = t.credentials as ActionCredentials
  }
  const stream = parseStream(file, t)
  return { entry, prefix, maxBodyBytes, maxResponseBytes, crossSite, baseUrl, credentials, entryExplicit: t.entry !== undefined, ...(stream ? { stream } : {}) }
}

/** F475: `stream` + its bounds; the bounds are validated even without a list, and dropped with it. */
function parseStream(file: string, t: Record<string, unknown>): ActionsStreamConfig | undefined {
  const int = (key: string, min: number, max: number, dflt: number): number => {
    const n = t[key]
    if (n === undefined) return dflt
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new BuildError('config', `${file}: actions.${key} must be an integer in ${min}..${max} (got ${String(n)})`)
    return n
  }
  const maxStreamBytes = int('max_stream_bytes', 1, MAX_STREAM_BYTES, DEFAULT_MAX_STREAM_BYTES)
  const streamIdleMs = int('stream_idle_ms', 1, U32_MAX, DEFAULT_STREAM_IDLE_MS)
  const streamTotalMs = int('stream_total_ms', 1, U32_MAX, DEFAULT_STREAM_TOTAL_MS)
  const maxStreams = t.max_streams === undefined ? undefined : int('max_streams', 1, U32_MAX, 1)
  if (t.stream === undefined) return undefined
  if (!Array.isArray(t.stream)) throw new BuildError('config', `${file}: actions.stream must be an array of "<METHOD> <path>" strings`)
  const stream: string[] = []
  for (const e of t.stream) {
    const why = streamEntryError(e)
    if (why) throw new BuildError('config', `${file}: actions.stream entry ${why}`)
    const [m, p] = (e as string).trim().split(/ +/)
    stream.push(`${m!.toUpperCase()} ${p}`)
  }
  if (stream.length === 0) return undefined
  return { stream, maxStreamBytes, streamIdleMs, streamTotalMs, ...(maxStreams !== undefined ? { maxStreams } : {}) }
}

const DEFAULT_ENTRY = 'actions.ts'

/** `[css]`: only `global`, a list of `.css` files relative to the app root (checked to exist by the build). */
function parseCss(file: string, raw: unknown): string[] {
  if (raw === undefined) return []
  if (!isTable(raw)) throw new BuildError('config', `${file}: [css] must be a table`)
  for (const k of Object.keys(raw)) if (k !== 'global') throw new BuildError('config', `${file}: unknown key css.${k} (allowed: global)`)
  const g = raw.global
  if (g === undefined) return []
  if (!Array.isArray(g) || g.some((p) => typeof p !== 'string' || !p.trim().endsWith('.css')))
    throw new BuildError('config', `${file}: css.global must be an array of .css paths (relative to the app root)`)
  return g.map((p: string) => p.trim())
}

/**
 * `[build] source_roots` (F256): extra directories, relative to the app root, that a relative import may reach besides
 * the app itself (`../shared` in a monorepo). Each is normalised (`../a/../shared` = `../shared`), must exist and be a
 * directory, and confines imports the way the app root does: lexically, so `../shared/../secret` is outside it.
 * An entry inside the app adds nothing and is dropped; the app root itself or an ancestor of it is refused (F272). Returns the roots that lie outside, `/`-separated.
 */
export function parseSourceRoots(file: string, appRoot: string, raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || p.trim() === '' || p.includes('\0')))
    throw new BuildError('config', `${file}: build.source_roots must be an array of non-empty strings (paths relative to the app root)`)
  const out = new Set<string>()
  for (const p of raw as string[]) {
    if (isAbsolute(p.trim())) throw new BuildError('config', `${file}: build.source_roots entry ${JSON.stringify(p)} must be relative to the app root`)
    const abs = resolve(appRoot, p.trim())
    let dir = false
    try {
      dir = statSync(abs).isDirectory()
    } catch {}
    if (!dir) throw new BuildError('config', `${file}: build.source_roots entry ${JSON.stringify(p)} (${abs}) is not an existing directory`)
    if (abs === resolve(abs, '..')) throw new BuildError('config', `${file}: build.source_roots entry ${JSON.stringify(p)} is the filesystem root`)
    const rel = relative(appRoot, abs).split(sep).join('/')
    // F272: the app root or an ancestor of it (`.`, `..`, `../..`) contains every import the app can make, so it would
    // switch F243's confinement off for that whole level; name the directory that is actually shared instead.
    if (rel === '' || rel.split('/').every((seg) => seg === '..'))
      throw new BuildError(
        'config',
        `${file}: build.source_roots entry ${JSON.stringify(p)} is the app root or a directory that contains it, which would allow every relative import; list the shared directory itself (e.g. "../shared")`,
      )
    if (rel === '..' || rel.startsWith('../')) out.add(rel)
  }
  return [...out].sort()
}

export async function loadBuildConfig(appRoot: string, o: { actionsOnly?: boolean } = {}): Promise<BuildConfig> {
  const file = join(appRoot, 'brust.toml')
  const f = Bun.file(file)
  if (!(await f.exists())) return { serverOnly: [], actions: null, cloudflare: null, cache: null, cssGlobal: [], sourceRoots: [] }
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(await f.text())
  } catch (e) {
    throw new BuildError('config', `failed to parse ${file}: ${(e as Error).message}`)
  }
  const root = (parsed ?? {}) as Record<string, unknown>
  const actions = parseActions(file, root.actions, o.actionsOnly === true)
  const cloudflare = parseCloudflare(file, appRoot, root.cloudflare)
  const cache = await parseCache(file, appRoot, root.cache)
  const cssGlobal = parseCss(file, root.css)
  const build = root.build
  if (build === undefined) return { serverOnly: [], actions, cloudflare, cache, cssGlobal, sourceRoots: [] }
  if (build === null || typeof build !== 'object' || Array.isArray(build)) throw new BuildError('config', `${file}: [build] must be a table`)
  const sourceRoots = parseSourceRoots(file, appRoot, (build as Record<string, unknown>).source_roots)
  const so = (build as Record<string, unknown>).server_only
  if (so === undefined) return { serverOnly: [], actions, cloudflare, cache, cssGlobal, sourceRoots }
  if (!Array.isArray(so) || so.some((p) => typeof p !== 'string' || p.trim() === ''))
    throw new BuildError('config', `${file}: build.server_only must be an array of non-empty strings`)
  return { serverOnly: so.map((p: string) => p.trim().replace(/^\.\//, '')), actions, cloudflare, cache, cssGlobal, sourceRoots }
}
