// Runtime configuration (spec §8). Precedence, high → low:
//   env (BRUST_ADDR / BRUST_PORT / BRUST_WORKERS / BRUST_RENDER_SLOTS / BRUST_DRAIN_TIMEOUT_MS /
//        BRUST_BOOT_TIMEOUT_MS / BRUST_CALL_TIMEOUT_MS)
//   > CLI flags (`brust start --port/--workers`)
//   > brust.toml ([server] address / port, [workers] count)
//   > defaults (localhost, 1337, availableParallelism(), 1, 10000, 30000, 30000).
// `brust start`'s BRUST_DIST_DIR / BRUST_APP_ENTRY follow the same env > flag rule (run.ts).
// A missing brust.toml is fine; a present one with the wrong shape is an error. Messages follow
// 0.1.x `runtime/config.ts`.
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

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

const DEFAULTS = { host: 'localhost', port: 1337, renderSlots: 1, drainTimeoutMs: 10_000, bootTimeoutMs: 30_000, callTimeoutMs: 30_000 }

/** Ceilings: ms values cross napi as `u32` (a larger number would wrap), more than 1024 Bun
 * workers is a misconfiguration, not a deployment, and each render slot is a 256 KiB shared
 * response buffer per worker (more than 64 would only exhaust memory). */
export const MAX_MS = 0xffff_ffff
export const MAX_WORKERS = 1024
export const MAX_RENDER_SLOTS = 64

export async function loadConfig(cwd: string = process.cwd(), cli: Partial<BrustConfig> = {}): Promise<BrustConfig> {
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
  return {
    host: env.host ?? cli.host ?? fromToml.host ?? DEFAULTS.host,
    port: env.port ?? cli.port ?? fromToml.port ?? DEFAULTS.port,
    workers: env.workers ?? cli.workers ?? fromToml.workers ?? Math.min(availableParallelism(), MAX_WORKERS),
    renderSlots: env.renderSlots ?? cli.renderSlots ?? DEFAULTS.renderSlots,
    drainTimeoutMs: env.drainTimeoutMs ?? cli.drainTimeoutMs ?? DEFAULTS.drainTimeoutMs,
    bootTimeoutMs: env.bootTimeoutMs ?? cli.bootTimeoutMs ?? DEFAULTS.bootTimeoutMs,
    callTimeoutMs: env.callTimeoutMs ?? cli.callTimeoutMs ?? DEFAULTS.callTimeoutMs,
  }
}

/** CLI / programmatic overrides get the same bounds as env (a CLI `--port 0` = any free port). */
function checkCli(cli: Partial<BrustConfig>): void {
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
}

function table(v: unknown, what: string, file: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new BrustConfigError(`${file}: ${what} must be a table`, file)
  return v as Record<string, unknown>
}

function fromTomlTable(parsed: unknown, file: string): Partial<BrustConfig> {
  const root = table(parsed, 'top level', file)
  const out: Partial<BrustConfig> = {}
  if ('server' in root) {
    const server = table(root.server, '[server]', file)
    const { port, address } = server
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
    const { count } = table(root.workers, '[workers]', file)
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_WORKERS)
        throw new BrustConfigError(`${file}: workers.count must be an integer in 1..${MAX_WORKERS} (got ${JSON.stringify(count)})`, file)
      out.workers = count
    }
  }
  return out
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
  return out
}
