// Runtime configuration (spec §8). Precedence, high → low:
//   env (BRUST_ADDR / BRUST_PORT / BRUST_WORKERS / BRUST_RENDER_SLOTS / BRUST_DRAIN_TIMEOUT_MS /
//        BRUST_BOOT_TIMEOUT_MS / BRUST_CALL_TIMEOUT_MS / BRUST_SLOT_BYTES / BRUST_MAX_LOADER_RESPONSE_BYTES / BRUST_STATS)
//   > CLI flags (`brust start --port/--workers`) and `run({ config })`
//   > brust.toml ([server] address / port / base_path / stats / stats_token / max_loader_response_bytes, [workers] count / slot_bytes, [cors], [actions] base_url / credentials)
//   > defaults (localhost, 1337, availableParallelism(), 1, 10000, 30000, 30000, 262144, 8388608).
// L16 R16.1: `actionsBaseUrl` follows env (BRUST_ACTIONS_BASE_URL) > run({ config }) > toml `[actions] base_url`.
// `cors` has no env layer; `run({ config: { cors } })` replaces a toml `[cors]` as a whole (never merged), and
// `cors: null` turns a toml `[cors]` off.
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
  /** `run({ config: { cors } })` over brust.toml `[cors]` (a whole-object replace); absent = CORS off. No env layer. */
  cors?: CorsConfig
  /** F495 `[server] base_path` / `run({ config: { basePath } })`: the path the app is mounted under on a shared origin (`/portal`; `''` = the
   * root), absent when nothing set it. A build setting too (`brust build` bakes it into the manifest): `brust start` refuses a manifest
   * built for another one, and with none set serves the one the manifest names. */
  basePath?: string
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
export type ConfigOverrides = Omit<Partial<BrustConfig>, 'cors'> & { cors?: (Omit<CorsConfig, 'credentials'> & { credentials?: boolean }) | null }

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
    ...pick('basePath', cli.basePath ?? fromToml.basePath),
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
  const tomlPath = join(cwd, 'brust.toml')
  const file = Bun.file(tomlPath)
  if (!(await file.exists())) return undefined
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(await file.text())
  } catch (e) {
    throw new BrustConfigError(`failed to parse ${tomlPath}: ${(e as Error).message}`, tomlPath)
  }
  const root = (parsed ?? {}) as Record<string, unknown>
  return 'cors' in root ? parseCors(root.cors, tomlPath) : undefined
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
  if (cli.basePath !== undefined) {
    const r = normalizeBasePath(cli.basePath)
    if (!r.ok) throw new BrustConfigError(`config.basePath ${r.why}`, null)
    cli.basePath = r.value
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

function tomlInt(v: unknown, name: string, min: number, max: number, file: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new BrustConfigError(`${file}: ${name} must be an integer in ${min}..${max} (got ${JSON.stringify(v)})`, file)
  return v
}

function fromTomlTable(parsed: unknown, file: string): Partial<BrustConfig> {
  const root = table(parsed, 'top level', file)
  const out: Partial<BrustConfig> = {}
  if ('server' in root) {
    const server = table(root.server, '[server]', file)
    const { port, address } = server
    if (server.base_path !== undefined) {
      const r = normalizeBasePath(server.base_path)
      if (!r.ok) throw new BrustConfigError(`${file}: server.base_path ${r.why}`, file)
      out.basePath = r.value
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
