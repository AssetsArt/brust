// Runtime configuration (spec §8). Precedence, high → low:
//   env (BRUST_ADDR / BRUST_PORT / BRUST_WORKERS / BRUST_RENDER_SLOTS / BRUST_DRAIN_TIMEOUT_MS /
//        BRUST_BOOT_TIMEOUT_MS / BRUST_CALL_TIMEOUT_MS / BRUST_SLOT_BYTES / BRUST_MAX_LOADER_RESPONSE_BYTES / BRUST_STATS)
//   > CLI flags (`brust start --port/--workers`) and `run({ config })`
//   > brust.toml ([server] address / port / base_path / stats / stats_token / max_loader_response_bytes, [workers] count / slot_bytes, [cors], [csp], [actions] base_url / credentials, [components] cache_entries)
//   > defaults (localhost, 1337, availableParallelism(), 1, 10000, 30000, 30000, 262144, 8388608).
// L16 R16.1: `actionsBaseUrl` follows env (BRUST_ACTIONS_BASE_URL) > run({ config }) > toml `[actions] base_url`.
// `cors` has no env layer; `run({ config: { cors } })` replaces a toml `[cors]` as a whole (never merged), and
// `cors: null` turns a toml `[cors]` off. `csp` follows the same rule (F539).
// `brust start`'s BRUST_DIST_DIR / BRUST_APP_ENTRY follow the same env > flag rule (run.ts).
// A missing brust.toml is fine; a present one with the wrong shape is an error. Messages follow
// 0.1.x `runtime/config.ts`.
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { ACTION_CREDENTIALS, type ActionCredentials, baseUrlError } from './actions/prefix'

/** `[cors]` in brust.toml; same shape and validation as the Rust `CorsConfig` (crates/brust-server/src/config.rs). */
export interface CorsConfig {
  origins: string[]
  methods?: string[]
  headers?: string[]
  exposeHeaders?: string[]
  credentials: boolean
  maxAgeSeconds?: number
}

/** F539 `[csp]` in brust.toml (on with `enabled = true`); same shape and validation as the Rust `CspConfig`
 * (crates/brust-core/src/csp.rs). Each list adds sources to the directive brust composes. */
export interface CspConfig {
  mode: CspMode
  scriptSrc?: string[]
  /** Lets `scriptSrc` hold the sources that void the hashes (`'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `*`, a bare scheme). */
  scriptSrcUnsafe?: boolean
  /** `style-src-elem` extras, keywords included (`'unsafe-inline'` for an app that writes `<style>` inline). */
  styleSrc?: string[]
  connectSrc?: string[]
  imgSrc?: string[]
  fontSrc?: string[]
  frameAncestors?: string[]
  reportUri?: string
  /** F544: `default-src`; `'none'` makes brust name every directive its own runtime needs. Absent = `'self'`. */
  defaultSrc?: SelfOrNone
  /** F544: `base-uri`. Absent = `'self'`. */
  baseUri?: SelfOrNone
  /** F544: `form-action 'self'` plus these. */
  formAction?: string[]
  frameSrc?: string[]
  mediaSrc?: string[]
  workerSrc?: string[]
  manifestSrc?: string[]
  /** F544: absent = `object-src 'none'`. */
  objectSrc?: string[]
  /** F544: send the header under `brust dev` too (with the dev additions); its mode is `devMode`, `report-only` by default. */
  dev?: boolean
  devMode?: CspMode
  /** F544, set by the run, never by config: a static render drops `{host}` sources (napi `dropHost`). */
  dropHost?: boolean
}
export const CSP_MODES = ['enforce', 'report-only'] as const
export type CspMode = (typeof CSP_MODES)[number]
export const SELF_OR_NONE = ['self', 'none'] as const
export type SelfOrNone = (typeof SELF_OR_NONE)[number]
/** F544 `BRUST_CSP_MODE`: the per-deploy switch over `[csp]` (`off`, or turn it on in a mode). */
export const CSP_ENV_MODES = ['off', 'report-only', 'enforce'] as const

/** F507 `[server] stats`: who may read `/_brust/cache/stats`. */
export const STATS_MODES = ['off', 'public', 'token'] as const
export type StatsMode = (typeof STATS_MODES)[number]
/** F507 `[server] stats_token`: an env reference only, never the secret itself (like `[cache.redis] url`). */
const STATS_TOKEN_REF = /^env:[A-Za-z_][A-Za-z0-9_]*$/

/** Why `[server] stats` / `stats_token` (or `run({ config })`) are wrong, or `undefined`. The secret never appears in the message. */
function statsError(mode: unknown, token: unknown, where: string): string | undefined {
  if (mode !== undefined && !STATS_MODES.includes(mode as StatsMode)) return `${where}stats must be one of ${STATS_MODES.join(', ')} (got ${JSON.stringify(mode)})`
  if (token !== undefined && (typeof token !== 'string' || !STATS_TOKEN_REF.test(token)))
    return `${where}stats_token must be "env:NAME" (a literal token is refused: it would sit in a file)`
  return undefined
}

export interface BrustConfig {
  host: string
  port: number
  workers: number
  renderSlots: number
  drainTimeoutMs: number
  /** How long `brust start` waits for every worker to register. */
  bootTimeoutMs: number
  /** A claimed loader/job call that has not settled after this long answers 504. */
  callTimeoutMs: number
  /** tokio threads of the HTTP runtime (renders every page); absent = one per core (server default). */
  ioThreads?: number
  /** The SAB response slot of one render slot, bytes (`slot_bytes`, env BRUST_SLOT_BYTES); 64 KiB..16 MiB. */
  slotBytes: number
  /** The biggest loader/jobs reply that crosses by heap when it does not fit the slot (`max_loader_response_bytes`,
   * env BRUST_MAX_LOADER_RESPONSE_BYTES); 256 KiB..64 MiB. */
  maxLoaderResponseBytes: number
  /** F519 `[components] cache_entries`: runtime components kept warm per server (`<Dynamic>`); absent = 2048. */
  componentsCacheEntries?: number
  /** `run({ config: { cors } })` over brust.toml `[cors]` (a whole-object replace); absent = CORS off. No env layer. */
  cors?: CorsConfig
  /** F539 `[csp]` / `run({ config: { csp } })` (a whole-object replace; `null` = off); absent = no Content-Security-Policy header.
   * F544: env `BRUST_CSP_MODE` overrides it (`off`, or `report-only` / `enforce` over the table, enabled or not). */
  csp?: CspConfig
  /** F544: the brust.toml `[csp]` table even when `enabled` is not true, for `BRUST_CSP_MODE` to turn on. */
  cspTable?: CspConfig
  /** F495 `[server] base_path` / `run({ config: { basePath } })`: the path the app is mounted under on a shared origin (`/portal`; `''` = the
   * root), absent when nothing set it. A build setting too (`brust build` bakes it into the manifest): `brust start` refuses a manifest
   * built for another one, and with none set serves the one the manifest names. */
  basePath?: string
  /** F506 `[server] trailing_slash` / `run({ config: { trailingSlash } })`: what a page request whose path ends in `/` gets — `strict` (matched
   * as written, the default), `redirect` (GET/HEAD answer 308 to the path without it, query kept) or `ignore` (the slash is dropped before
   * matching). A build setting too (baked into the manifest): `brust start` refuses a manifest built with another one. */
  trailingSlash?: TrailingSlash
  /** F507 `[server] stats` / `run({ config: { stats } })`: who may read `/_brust/cache/stats` (`off` = 404, `public`, `token` = a bearer
   * token). Absent = `off` for `brust start`, `public` under `brust dev`. */
  stats?: StatsMode
  /** F507 `[server] stats_token` / `run({ config: { statsToken } })`: `"env:NAME"`, the variable that holds the bearer token (`stats = "token"` only). */
  statsToken?: string
  /** L16 R16.1: the origin the browser `client()` calls (page script `__BRUST_ACTION_BASE__`); absent = same origin. */
  actionsBaseUrl?: string
  /** L16 R16.2: the client's default `RequestInit.credentials` (`__BRUST_ACTION_CREDENTIALS__`); absent = `same-origin`. */
  actionsCredentials?: ActionCredentials
}

/** What `run({ config })` / `loadConfig`'s `cli` accepts: any setting, and `cors: null` to turn a toml `[cors]` off. */
export type ConfigOverrides = Omit<Partial<BrustConfig>, 'cors' | 'csp' | 'cspTable'> & {
  cors?: (Omit<CorsConfig, 'credentials'> & { credentials?: boolean }) | null
  csp?: (Omit<CspConfig, 'mode'> & { mode?: CspMode }) | null
}

/** F506: the `[server] trailing_slash` values. */
export const TRAILING_SLASH = ['strict', 'redirect', 'ignore'] as const
export type TrailingSlash = (typeof TRAILING_SLASH)[number]

/** F506: `[server] trailing_slash`, validated; the reason it is refused otherwise. */
export function checkTrailingSlash(raw: unknown): { ok: true; value: TrailingSlash } | { ok: false; why: string } {
  if (typeof raw === 'string' && (TRAILING_SLASH as readonly string[]).includes(raw)) return { ok: true, value: raw as TrailingSlash }
  return { ok: false, why: `must be one of ${TRAILING_SLASH.map((v) => JSON.stringify(v)).join(', ')} (got ${JSON.stringify(raw)})` }
}

/** F495: `[server] base_path`, validated: `/seg[/seg…]`, no trailing `/`, each segment `[A-Za-z0-9._~-]+` (not `.`/`..`), the
 * same alphabet as the actions prefix, so it needs no percent-encoding anywhere it is printed. `""` and `"/"` mean the
 * root (`""`). Returns the value, or the reason it is refused. */
export function normalizeBasePath(raw: unknown): { ok: true; value: string } | { ok: false; why: string } {
  if (typeof raw !== 'string') return { ok: false, why: `must be a string (got ${JSON.stringify(raw)})` }
  if (raw === '' || raw === '/') return { ok: true, value: '' }
  if (!raw.startsWith('/')) return { ok: false, why: `must start with '/' (got ${JSON.stringify(raw)})` }
  if (raw.endsWith('/')) return { ok: false, why: `must not end with '/' (got ${JSON.stringify(raw)})` }
  if (raw.slice(1).split('/').some((seg) => !/^[A-Za-z0-9._~-]+$/.test(seg) || seg === '.' || seg === '..'))
    return { ok: false, why: `segments must be [A-Za-z0-9._~-]+ and not '.'/'..' (got ${JSON.stringify(raw)})` }
  return { ok: true, value: raw }
}

export class BrustConfigError extends Error {
  override name = 'BrustConfigError'
  constructor(
    message: string,
    public readonly file: string | null,
  ) {
    super(message)
  }
}

const DEFAULTS = { host: 'localhost', port: 1337, drainTimeoutMs: 10_000, bootTimeoutMs: 30_000, callTimeoutMs: 30_000, slotBytes: 256 * 1024, maxLoaderResponseBytes: 8_388_608 }

/** Ceilings: ms values cross napi as `u32` (a larger number would wrap), more than 1024 Bun
 * workers is a misconfiguration, not a deployment, and each render slot is a `slotBytes` (default 256 KiB)
 * shared response buffer per worker (more than 64 would only exhaust memory). */
export const MAX_MS = 0xffff_ffff
/** `max_age_seconds` crosses napi as `u32`, like the ms values. */
const MAX_U32 = 0xffff_ffff
/** tokio I/O threads (BRUST_WORKER_THREADS); more than this is a misconfiguration. */
export const MAX_IO_THREADS = 256
export const MAX_WORKERS = 1024
export const MAX_RENDER_SLOTS = 64
/** `slotBytes` (L10): 64 KiB..16 MiB. */
export const MIN_SLOT_BYTES = 64 * 1024
export const MAX_SLOT_BYTES = 16 * 1024 * 1024
/** `maxLoaderResponseBytes` (L10): 256 KiB..64 MiB, like the actions limits. */
export const MIN_LOADER_RESPONSE_BYTES = 256 * 1024
export const MAX_LOADER_RESPONSE_BYTES = 64 * 1024 * 1024

export async function loadConfig(cwd: string = process.cwd(), cli: ConfigOverrides = {}): Promise<BrustConfig> {
  const tomlPath = join(cwd, 'brust.toml')
  let fromToml: Partial<BrustConfig> = {}
  const file = Bun.file(tomlPath)
  if (await file.exists()) {
    // Parsed from text (not `import()`): no module cache, so a rewritten file is re-read.
    let parsed: unknown
    try {
      parsed = Bun.TOML.parse(await file.text())
    } catch (e) {
      throw new BrustConfigError(`failed to parse ${tomlPath}: ${(e as Error).message}`, tomlPath)
    }
    fromToml = fromTomlTable(parsed, tomlPath)
  }
  const env = fromEnv()
  checkCli(cli)
  // cli (validated, normalised) over toml as a whole object (R10.2); `null` = off.
  const cors = cli.cors === undefined ? fromToml.cors : cli.cors === null ? undefined : checkCors(cli.cors, 'config.cors', null, false)
  const configured = cli.csp === undefined ? fromToml.csp : cli.csp === null ? undefined : checkCsp(cli.csp, 'config.csp', null, false)
  const csp = withCspEnv(configured, fromToml.cspTable, process.env.BRUST_CSP_MODE)
  // F507: the two keys belong together, wherever each one came from.
  const stats = env.stats ?? cli.stats ?? fromToml.stats
  const statsToken = cli.statsToken ?? fromToml.statsToken
  if (stats === 'token' && statsToken === undefined) throw new BrustConfigError('stats = "token" needs stats_token = "env:NAME" (the variable that holds the bearer token)', null)
  if (statsToken !== undefined && stats !== 'token') throw new BrustConfigError('stats_token is used only with stats = "token"', null)
  return {
    host: env.host ?? cli.host ?? fromToml.host ?? DEFAULTS.host,
    port: env.port ?? cli.port ?? fromToml.port ?? DEFAULTS.port,
    workers: env.workers ?? cli.workers ?? fromToml.workers ?? Math.min(availableParallelism(), MAX_WORKERS),
    // min(cores, 16) slots per worker, like 0.1.x (ruling 7ffa9b19): 1 slot left 6 calls in flight for 6 workers.
    renderSlots: env.renderSlots ?? cli.renderSlots ?? Math.min(availableParallelism(), 16),
    drainTimeoutMs: env.drainTimeoutMs ?? cli.drainTimeoutMs ?? DEFAULTS.drainTimeoutMs,
    bootTimeoutMs: env.bootTimeoutMs ?? cli.bootTimeoutMs ?? DEFAULTS.bootTimeoutMs,
    callTimeoutMs: env.callTimeoutMs ?? cli.callTimeoutMs ?? DEFAULTS.callTimeoutMs,
    slotBytes: env.slotBytes ?? cli.slotBytes ?? fromToml.slotBytes ?? DEFAULTS.slotBytes,
    maxLoaderResponseBytes: env.maxLoaderResponseBytes ?? cli.maxLoaderResponseBytes ?? fromToml.maxLoaderResponseBytes ?? DEFAULTS.maxLoaderResponseBytes,
    ioThreads: env.ioThreads ?? cli.ioThreads,
    ...(cors ? { cors } : {}),
    ...(csp ? { csp } : {}),
    ...pick('componentsCacheEntries', cli.componentsCacheEntries ?? fromToml.componentsCacheEntries),
    ...pick('basePath', cli.basePath ?? fromToml.basePath),
    ...pick('trailingSlash', cli.trailingSlash ?? fromToml.trailingSlash),
    ...pick('stats', stats),
    ...pick('statsToken', statsToken),
    ...pick('actionsBaseUrl', env.actionsBaseUrl ?? cli.actionsBaseUrl ?? fromToml.actionsBaseUrl),
    ...pick('actionsCredentials', cli.actionsCredentials ?? fromToml.actionsCredentials),
  }
}

const pick = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as { [P in K]: V }))

/** `[cors]` of brust.toml and nothing else (no env, no cli): what the Cloudflare build ships in CONFIG.
 * Throws `BrustConfigError` on a bad table, exactly like `loadConfig`. */
export async function loadCors(cwd: string): Promise<CorsConfig | undefined> {
  const t = await tomlRoot(cwd)
  return t && 'cors' in t.root ? parseCors(t.root.cors, t.path) : undefined
}

/** F539: `[csp]` of brust.toml and nothing else, for the Cloudflare CONFIG (like [`loadCors`]); `undefined` when off. */
export async function loadCsp(cwd: string): Promise<CspConfig | undefined> {
  const t = await loadCspTable(cwd)
  return t?.enabled ? t.csp : undefined
}

/** F544: `[csp]` of brust.toml with whether it is enabled; the Cloudflare CONFIG carries it either way, for the Worker's
 * `BRUST_CSP_MODE` binding to turn on. */
export async function loadCspTable(cwd: string): Promise<{ csp: CspConfig; enabled: boolean } | undefined> {
  const t = await tomlRoot(cwd)
  return t && 'csp' in t.root ? parseCspTable(t.root.csp, t.path) : undefined
}

/** F544: the `{host}` sources of `csp` as `<snake_key> <source>`, for the builds that have no request to expand them with
 * (static pages, Cloudflare public/ HTML): the core drops them there, and the build says so. */
export function cspHostSources(csp: CspConfig | undefined): string[] {
  if (!csp) return []
  const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
  return CSP_LISTS.flatMap((k) => (csp[k] ?? []).filter((s) => s.includes(CSP_HOST)).map((s) => `${snake(k)} ${s}`))
}

/** F544 `BRUST_CSP_MODE` over the configured policy: `off` = none; `report-only` / `enforce` = the policy (or the brust.toml
 * table even when not enabled, or the default policy) in that mode; unset or empty = as configured. A bad value throws. */
export function withCspEnv(configured: CspConfig | undefined, table: CspConfig | undefined, raw: string | undefined): CspConfig | undefined {
  if (raw === undefined || raw === '') return configured
  if (!(CSP_ENV_MODES as readonly string[]).includes(raw)) throw new BrustConfigError(`BRUST_CSP_MODE must be one of ${CSP_ENV_MODES.join(', ')} (got ${JSON.stringify(raw)})`, null)
  if (raw === 'off') return undefined
  return { ...(configured ?? table ?? {}), mode: raw as CspMode }
}

async function tomlRoot(cwd: string): Promise<{ root: Record<string, unknown>; path: string } | undefined> {
  const tomlPath = join(cwd, 'brust.toml')
  const file = Bun.file(tomlPath)
  if (!(await file.exists())) return undefined
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(await file.text())
  } catch (e) {
    throw new BrustConfigError(`failed to parse ${tomlPath}: ${(e as Error).message}`, tomlPath)
  }
  return { root: (parsed ?? {}) as Record<string, unknown>, path: tomlPath }
}

/** CLI / programmatic overrides get the same bounds as env (a CLI `--port 0` = any free port). */
function checkCli(cli: ConfigOverrides): void {
  const check = (name: string, v: number | undefined, min: number, max: number) => {
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max))
      throw new BrustConfigError(`${name} must be an integer in ${min}..${max} (got ${JSON.stringify(v)})`, null)
  }
  check('--port', cli.port, 0, 65535)
  check('--workers', cli.workers, 1, MAX_WORKERS)
  check('renderSlots', cli.renderSlots, 1, MAX_RENDER_SLOTS)
  check('drainTimeoutMs', cli.drainTimeoutMs, 0, MAX_MS)
  check('bootTimeoutMs', cli.bootTimeoutMs, 1, MAX_MS)
  check('callTimeoutMs', cli.callTimeoutMs, 1, MAX_MS)
  check('ioThreads', cli.ioThreads, 1, MAX_IO_THREADS)
  check('slotBytes', cli.slotBytes, MIN_SLOT_BYTES, MAX_SLOT_BYTES)
  check('maxLoaderResponseBytes', cli.maxLoaderResponseBytes, MIN_LOADER_RESPONSE_BYTES, MAX_LOADER_RESPONSE_BYTES)
  check('componentsCacheEntries', cli.componentsCacheEntries, 1, MAX_COMPONENTS_CACHE_ENTRIES)
  if (cli.basePath !== undefined) {
    const r = normalizeBasePath(cli.basePath)
    if (!r.ok) throw new BrustConfigError(`config.basePath ${r.why}`, null)
    cli.basePath = r.value
  }
  if (cli.trailingSlash !== undefined) {
    const r = checkTrailingSlash(cli.trailingSlash)
    if (!r.ok) throw new BrustConfigError(`config.trailingSlash ${r.why}`, null)
  }
  const badStats = statsError(cli.stats, cli.statsToken, 'config.')
  if (badStats) throw new BrustConfigError(badStats, null)
  if (cli.actionsBaseUrl !== undefined) {
    const why = baseUrlError(cli.actionsBaseUrl)
    if (why) throw new BrustConfigError(`config.actionsBaseUrl ${why}`, null)
  }
  if (cli.actionsCredentials !== undefined && !ACTION_CREDENTIALS.includes(cli.actionsCredentials))
    throw new BrustConfigError(`config.actionsCredentials must be one of ${ACTION_CREDENTIALS.join(', ')} (got ${JSON.stringify(cli.actionsCredentials)})`, null)
}

function table(v: unknown, what: string, file: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new BrustConfigError(`${file}: ${what} must be a table`, file)
  return v as Record<string, unknown>
}

/** F519 `[components] cache_entries`: 1..1_000_000 (each entry holds up to 512 KiB of artifact). */
export const MAX_COMPONENTS_CACHE_ENTRIES = 1_000_000

function tomlInt(v: unknown, name: string, min: number, max: number, file: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new BrustConfigError(`${file}: ${name} must be an integer in ${min}..${max} (got ${JSON.stringify(v)})`, file)
  return v
}

function fromTomlTable(parsed: unknown, file: string): Partial<BrustConfig> {
  const root = table(parsed, 'top level', file)
  const out: Partial<BrustConfig> = {}
  if ('components' in root) {
    const components = table(root.components, '[components]', file)
    const n = tomlInt(components.cache_entries, 'components.cache_entries', 1, MAX_COMPONENTS_CACHE_ENTRIES, file)
    if (n !== undefined) out.componentsCacheEntries = n
  }
  if ('server' in root) {
    const server = table(root.server, '[server]', file)
    const { port, address } = server
    if (server.base_path !== undefined) {
      const r = normalizeBasePath(server.base_path)
      if (!r.ok) throw new BrustConfigError(`${file}: server.base_path ${r.why}`, file)
      out.basePath = r.value
    }
    if (server.trailing_slash !== undefined) {
      const r = checkTrailingSlash(server.trailing_slash)
      if (!r.ok) throw new BrustConfigError(`${file}: server.trailing_slash ${r.why}`, file)
      out.trailingSlash = r.value
    }
    const bad = statsError(server.stats, server.stats_token, `${file}: server.`)
    if (bad) throw new BrustConfigError(bad, file)
    if (server.stats !== undefined) out.stats = server.stats as StatsMode
    if (server.stats_token !== undefined) out.statsToken = server.stats_token as string
    const cap = tomlInt(server.max_loader_response_bytes, 'server.max_loader_response_bytes', MIN_LOADER_RESPONSE_BYTES, MAX_LOADER_RESPONSE_BYTES, file)
    if (cap !== undefined) out.maxLoaderResponseBytes = cap
    if (port !== undefined) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new BrustConfigError(`${file}: server.port must be an integer in 1..65535 (got ${JSON.stringify(port)})`, file)
      out.port = port
    }
    if (address !== undefined) {
      if (typeof address !== 'string' || address.trim() === '')
        throw new BrustConfigError(`${file}: server.address must be a non-empty string (got ${JSON.stringify(address)})`, file)
      out.host = address.trim()
    }
  }
  if ('workers' in root) {
    const w = table(root.workers, '[workers]', file)
    const { count } = w
    const slot = tomlInt(w.slot_bytes, 'workers.slot_bytes', MIN_SLOT_BYTES, MAX_SLOT_BYTES, file)
    if (slot !== undefined) out.slotBytes = slot
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_WORKERS)
        throw new BrustConfigError(`${file}: workers.count must be an integer in 1..${MAX_WORKERS} (got ${JSON.stringify(count)})`, file)
      out.workers = count
    }
  }
  if ('cors' in root) out.cors = parseCors(root.cors, file)
  if ('csp' in root) {
    const { csp, enabled } = parseCspTable(root.csp, file)
    out.cspTable = csp
    if (enabled) out.csp = csp
  }
  if ('actions' in root) {
    const a = table(root.actions, '[actions]', file)
    if (a.base_url !== undefined) {
      const why = baseUrlError(a.base_url)
      if (why) throw new BrustConfigError(`${file}: actions.base_url ${why}`, file)
      out.actionsBaseUrl = a.base_url as string
    }
    if (a.credentials !== undefined) {
      if (typeof a.credentials !== 'string' || !ACTION_CREDENTIALS.includes(a.credentials as ActionCredentials))
        throw new BrustConfigError(`${file}: actions.credentials must be one of ${ACTION_CREDENTIALS.join(', ')} (got ${JSON.stringify(a.credentials)})`, file)
      out.actionsCredentials = a.credentials as ActionCredentials
    }
  }
  return out
}

function parseCors(v: unknown, file: string): CorsConfig {
  return checkCors(corsFromToml(table(v, 'cors', file)), `${file}: cors`, file, true)
}

/** brust.toml `[cors]` (snake_case keys) → the camelCase shape [`checkCors`] validates. Unknown toml keys are ignored, as always. */
function corsFromToml(t: Record<string, unknown>): Record<string, unknown> {
  return { origins: t.origins, methods: t.methods, headers: t.headers, exposeHeaders: t.expose_headers, credentials: t.credentials, maxAgeSeconds: t.max_age_seconds }
}

const CORS_KEYS = ['origins', 'methods', 'headers', 'exposeHeaders', 'credentials', 'maxAgeSeconds']

/** The one `[cors]` validator (Rust `CorsConfig::validate`, verbatim), for toml (`where` = `<file>: cors`, key names in
 * snake_case) and for `run({ config: { cors } })` (`where` = `config.cors`, camelCase; an unknown key is an error). */
function checkCors(c: unknown, where: string, file: string | null, snake: boolean): CorsConfig {
  const fail = (m: string) => new BrustConfigError(m, file)
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw fail(`${where} must be ${file === null ? 'an object (or null)' : 'a table'} (got ${JSON.stringify(c)})`)
  const t = c as Record<string, unknown>
  if (!snake) {
    const bad = Object.keys(t).find((k) => !CORS_KEYS.includes(k))
    if (bad !== undefined) throw fail(`${where}.${bad} is not a cors option (expected ${CORS_KEYS.join(', ')})`)
  }
  const name = (k: string) => (snake ? k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`) : k)
  const strings = (val: unknown, key: string): string[] | undefined => {
    if (val === undefined) return undefined
    if (!Array.isArray(val) || val.some((x) => typeof x !== 'string')) throw fail(`${where}.${name(key)} must be an array of strings (got ${JSON.stringify(val)})`)
    return val as string[]
  }
  const origins = strings(t.origins, 'origins') ?? []
  const methods = strings(t.methods, 'methods')
  const headers = strings(t.headers, 'headers')
  const exposeHeaders = strings(t.exposeHeaders, 'exposeHeaders')
  if (t.credentials !== undefined && typeof t.credentials !== 'boolean') throw fail(`${where}.credentials must be a boolean (got ${JSON.stringify(t.credentials)})`)
  const credentials = t.credentials === true
  const age = t.maxAgeSeconds
  if (age !== undefined && (typeof age !== 'number' || !Number.isInteger(age) || age < 0 || age > MAX_U32))
    throw fail(`${where}.${name('maxAgeSeconds')} must be an integer in 0..${MAX_U32} (got ${JSON.stringify(age)})`)
  // Rust CorsConfig::validate, verbatim.
  if (origins.length === 0) throw fail(`${where}.origins must be non-empty`)
  if (credentials && origins.includes('*'))
    throw fail(`${where}.credentials cannot be combined with a wildcard origin '*' (browsers reject Access-Control-Allow-Origin: * with credentials); list explicit origins instead`)
  return {
    origins,
    ...(methods ? { methods } : {}),
    ...(headers ? { headers } : {}),
    ...(exposeHeaders ? { exposeHeaders } : {}),
    credentials,
    ...(age !== undefined ? { maxAgeSeconds: age as number } : {}),
  }
}

const CSP_KEYS = [
  'mode',
  'scriptSrc',
  'scriptSrcUnsafe',
  'styleSrc',
  'connectSrc',
  'imgSrc',
  'fontSrc',
  'frameAncestors',
  'reportUri',
  'defaultSrc',
  'baseUri',
  'formAction',
  'frameSrc',
  'mediaSrc',
  'workerSrc',
  'manifestSrc',
  'objectSrc',
  'dev',
  'devMode',
]
const CSP_LISTS = ['scriptSrc', 'styleSrc', 'connectSrc', 'imgSrc', 'fontSrc', 'frameAncestors', 'formAction', 'frameSrc', 'mediaSrc', 'workerSrc', 'manifestSrc', 'objectSrc'] as const
/** F544: the request-host placeholder (`wss://{host}`), expanded per response by the core. */
export const CSP_HOST = '{host}'

/** brust.toml `[csp]`: `enabled = true` turns it on (absent/false = off, the table is still checked). Unlike `[cors]`, an unknown
 * key is an error: a misspelt directive in a security policy must not pass silently. */
function parseCspTable(v: unknown, file: string): { csp: CspConfig; enabled: boolean } {
  const t = table(v, '[csp]', file)
  if (t.enabled !== undefined && typeof t.enabled !== 'boolean') throw new BrustConfigError(`${file}: csp.enabled must be a boolean (got ${JSON.stringify(t.enabled)})`, file)
  const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  const rest: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(t)) {
    if (k === 'enabled') continue
    if (!CSP_KEYS.includes(camel(k)) || /[A-Z]/.test(k))
      throw new BrustConfigError(`${file}: csp.${k} is not a csp option (expected enabled, ${CSP_KEYS.map((c) => c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)).join(', ')})`, file)
    rest[camel(k)] = val
  }
  return { csp: checkCsp(rest, `${file}: csp`, file, true), enabled: t.enabled === true }
}

/** Why one source expression is refused (Rust `csp::source`, verbatim), or `undefined`: one entry, ASCII, no `;` `,` or control
 * character, and a quote only as a whole `'keyword'`. Keywords (`'unsafe-inline'`, `'self'`, `'nonce-…'`, `'sha256-…'`) pass. */
export function cspSourceError(s: string): string | undefined {
  if (s.trim() === '') return 'is empty'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is exactly what is refused
  if (/[;,\u0000-\u001f\u007f]|[^\x00-\x7f]/.test(s)) return `${JSON.stringify(s)} holds ';', ',', a control or a non-ASCII character: one source per entry`
  const quotes = s.split("'").length - 1
  const t = s.trim()
  if (quotes !== 0 && !(quotes === 2 && t.length > 2 && t.startsWith("'") && t.endsWith("'"))) return `${JSON.stringify(s)} has unbalanced quotes: write a keyword as 'keyword'`
  return undefined
}

/** The one `[csp]` validator (Rust `CspConfig::validate`), for toml (snake_case names in messages) and `run({ config: { csp } })`. */
function checkCsp(c: unknown, where: string, file: string | null, snake: boolean): CspConfig {
  const fail = (m: string) => new BrustConfigError(m, file)
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw fail(`${where} must be ${file === null ? 'an object (or null)' : 'a table'} (got ${JSON.stringify(c)})`)
  const t = c as Record<string, unknown>
  const bad = Object.keys(t).find((k) => !CSP_KEYS.includes(k))
  if (bad !== undefined) throw fail(`${where}.${bad} is not a csp option (expected ${CSP_KEYS.join(', ')})`)
  const name = (k: string) => (snake ? k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`) : k)
  if (t.mode !== undefined && !CSP_MODES.includes(t.mode as CspMode)) throw fail(`${where}.mode must be one of ${CSP_MODES.join(', ')} (got ${JSON.stringify(t.mode)})`)
  if (t.scriptSrcUnsafe !== undefined && typeof t.scriptSrcUnsafe !== 'boolean') throw fail(`${where}.${name('scriptSrcUnsafe')} must be a boolean (got ${JSON.stringify(t.scriptSrcUnsafe)})`)
  for (const key of ['defaultSrc', 'baseUri'] as const)
    if (t[key] !== undefined && !SELF_OR_NONE.includes(t[key] as SelfOrNone)) throw fail(`${where}.${name(key)} must be one of ${SELF_OR_NONE.join(', ')} (got ${JSON.stringify(t[key])})`)
  if (t.dev !== undefined && typeof t.dev !== 'boolean') throw fail(`${where}.dev must be a boolean (got ${JSON.stringify(t.dev)})`)
  if (t.devMode !== undefined && !CSP_MODES.includes(t.devMode as CspMode)) throw fail(`${where}.${name('devMode')} must be one of ${CSP_MODES.join(', ')} (got ${JSON.stringify(t.devMode)})`)
  const out: CspConfig = { mode: (t.mode as CspMode | undefined) ?? 'enforce' }
  for (const key of ['defaultSrc', 'baseUri'] as const) if (t[key] !== undefined) out[key] = t[key] as SelfOrNone
  if (t.dev !== undefined) out.dev = t.dev as boolean
  if (t.devMode !== undefined) out.devMode = t.devMode as CspMode
  for (const key of CSP_LISTS) {
    const val = t[key]
    if (val === undefined) continue
    if (!Array.isArray(val) || val.some((x) => typeof x !== 'string')) throw fail(`${where}.${name(key)} must be an array of strings (got ${JSON.stringify(val)})`)
    for (const src of val as string[]) {
      const why = cspSourceError(src)
      if (why) throw fail(`${where}.${name(key)}: ${why}`)
    }
    out[key] = val as string[]
  }
  if (t.reportUri !== undefined) {
    if (typeof t.reportUri !== 'string') throw fail(`${where}.${name('reportUri')} must be a string (got ${JSON.stringify(t.reportUri)})`)
    const why = cspSourceError(t.reportUri)
    if (why) throw fail(`${where}.${name('reportUri')}: ${why}`)
    out.reportUri = t.reportUri
  }
  // F544: a per-request host as a script source would let any host name that reaches the server serve script.
  const hosted = out.scriptSrc?.find((s) => s.includes(CSP_HOST))
  if (hosted !== undefined)
    throw fail(`${where}.${name('scriptSrc')}: ${hosted} uses ${CSP_HOST}, which is refused here: a script source taken from the request's Host would let any host name that reaches this server serve script; name the hosts`)
  // Not unlocked by scriptSrcUnsafe: it does not weaken the policy, it breaks every page.
  const dynamic = out.scriptSrc?.find((s) => s.trim().toLowerCase() === "'strict-dynamic'")
  if (dynamic !== undefined)
    throw fail(
      `${where}.${name('scriptSrc')}: ${dynamic} is not supported: under it browsers ignore 'self' and host sources, so every brust <script src> (runtime, islands, navigation) would be blocked; it works only with nonces, which brust does not add yet`,
    )
  if (t.scriptSrcUnsafe === true) out.scriptSrcUnsafe = true
  else {
    const unsafe = out.scriptSrc?.find(voidsHashes)
    if (unsafe !== undefined)
      throw fail(
        `${where}.${name('scriptSrc')}: ${unsafe} would let any script run and void the hash policy ('unsafe-inline' is ignored next to hashes; 'unsafe-eval' / 'unsafe-hashes' allow eval / inline handlers; data:, blob:, filesystem:, * and a bare scheme such as https: allow scripts from anywhere); list hosts (https://cdn.example.com) instead, or set ${name('scriptSrcUnsafe')} = true to send it anyway`,
      )
  }
  return out
}

/** A `script-src` source that lets script in past the hashes (Rust `csp::voids_hashes`): the unsafe keywords (not
 * `'wasm-unsafe-eval'`), a bare scheme (`https:`, `data:`, `blob:`, `filesystem:`, …), and any source whose host part is
 * exactly `*` (a lone `*`, `https://` plus `*`, `*:443`, the same with a path): a lone `*` host matches every host. A host is fine. */
export function voidsHashes(s: string): boolean {
  const k = s.trim().toLowerCase()
  if (["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"].includes(k)) return true
  const scheme = /^[a-z][a-z0-9+.-]*$/
  if (k.endsWith(':') && scheme.test(k.slice(0, -1))) return true
  const at = k.indexOf('://')
  const rest = at >= 0 && scheme.test(k.slice(0, at)) ? k.slice(at + 3) : k
  return rest.split(/[:/]/)[0] === '*'
}

/** Integer env var in `[min, max]`; unset or empty = absent. */
function envInt(name: string, min: number, max: number, rule: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = /^\s*\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isInteger(n) || n < min || n > max) throw new BrustConfigError(`${name} must be ${rule} (got ${JSON.stringify(raw)})`, null)
  return n
}

function fromEnv(): Partial<BrustConfig> {
  const out: Partial<BrustConfig> = {}
  const addr = process.env.BRUST_ADDR
  if (addr !== undefined && addr !== '') {
    if (addr.trim() === '') throw new BrustConfigError('BRUST_ADDR must be a non-empty string', null)
    out.host = addr.trim()
  }
  out.port = envInt('BRUST_PORT', 1, 65535, 'an integer in 1..65535')
  out.workers = envInt('BRUST_WORKERS', 1, MAX_WORKERS, `an integer in 1..${MAX_WORKERS}`)
  out.renderSlots = envInt('BRUST_RENDER_SLOTS', 1, MAX_RENDER_SLOTS, `an integer in 1..${MAX_RENDER_SLOTS}`)
  out.drainTimeoutMs = envInt('BRUST_DRAIN_TIMEOUT_MS', 0, MAX_MS, `an integer in 0..${MAX_MS}`)
  out.bootTimeoutMs = envInt('BRUST_BOOT_TIMEOUT_MS', 1, MAX_MS, `an integer in 1..${MAX_MS}`)
  out.callTimeoutMs = envInt('BRUST_CALL_TIMEOUT_MS', 1, MAX_MS, `an integer in 1..${MAX_MS}`)
  out.slotBytes = envInt('BRUST_SLOT_BYTES', MIN_SLOT_BYTES, MAX_SLOT_BYTES, `an integer in ${MIN_SLOT_BYTES}..${MAX_SLOT_BYTES}`)
  out.maxLoaderResponseBytes = envInt('BRUST_MAX_LOADER_RESPONSE_BYTES', MIN_LOADER_RESPONSE_BYTES, MAX_LOADER_RESPONSE_BYTES, `an integer in ${MIN_LOADER_RESPONSE_BYTES}..${MAX_LOADER_RESPONSE_BYTES}`)
  out.ioThreads = envInt('BRUST_WORKER_THREADS', 1, MAX_IO_THREADS, `an integer in 1..${MAX_IO_THREADS}`)
  const stats = process.env.BRUST_STATS
  if (stats !== undefined && stats !== '') {
    if (!STATS_MODES.includes(stats as StatsMode)) throw new BrustConfigError(`BRUST_STATS must be one of ${STATS_MODES.join(', ')} (got ${JSON.stringify(stats)})`, null)
    out.stats = stats as StatsMode
  }
  const base = process.env.BRUST_ACTIONS_BASE_URL
  if (base !== undefined && base !== '') {
    const why = baseUrlError(base)
    if (why) throw new BrustConfigError(`BRUST_ACTIONS_BASE_URL ${why}`, null)
    out.actionsBaseUrl = base
  }
  return out
}
