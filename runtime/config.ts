import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'

export interface BrustConfig {
  /** TCP port to bind on. Default 3000. */
  port: number
  /** Bun Worker count for render dispatch. Default floor(availableParallelism * 1.8). */
  workers: number
  /** Cache capacity (entries). Undefined → Rust default of 1000. */
  cacheMaxEntries?: number
}

export class BrustConfigError extends Error {
  constructor(message: string, public readonly file: string | null) {
    super(message)
    this.name = 'BrustConfigError'
  }
}

const DEFAULT_PORT = 3000
const defaultWorkers = (): number => Math.floor(os.availableParallelism() * 1.8)

const CONFIG_BASENAME = 'brust.toml'

/**
 * Resolve Brust configuration. Precedence (low → high): defaults < TOML < env.
 *
 * - Defaults: { port: 3000, workers: floor(availableParallelism * 1.8) }
 * - TOML: brust.toml at `cwd` (missing file is fine — only a present file with
 *   wrong shape is an error).
 * - Env: BRUST_PORT and BRUST_WORKERS override either source.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<BrustConfig> {
  let fromToml: Partial<BrustConfig> = {}
  const tomlPath = path.join(cwd, CONFIG_BASENAME)

  const file = Bun.file(tomlPath)
  if (await file.exists()) {
    let parsed: unknown
    try {
      parsed = parseToml(await file.text())
    } catch (e) {
      throw new BrustConfigError(
        `failed to parse ${tomlPath}: ${(e as Error).message}`,
        tomlPath,
      )
    }
    fromToml = extractFromToml(parsed, tomlPath)
  }

  const fromEnv = extractFromEnv()

  const port = fromEnv.port ?? fromToml.port ?? DEFAULT_PORT
  const workers = fromEnv.workers ?? fromToml.workers ?? defaultWorkers()

  return { port, workers, cacheMaxEntries: fromToml.cacheMaxEntries }
}

function extractFromToml(parsed: unknown, file: string): Partial<BrustConfig> {
  if (parsed === null || typeof parsed !== 'object') {
    throw new BrustConfigError(`${file}: top level must be a table`, file)
  }
  const root = parsed as Record<string, unknown>
  const out: Partial<BrustConfig> = {}

  if ('server' in root) {
    const server = root.server
    if (server === null || typeof server !== 'object') {
      throw new BrustConfigError(`${file}: [server] must be a table`, file)
    }
    const port = (server as Record<string, unknown>).port
    if (port !== undefined) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new BrustConfigError(
          `${file}: server.port must be an integer in 1..65535 (got ${JSON.stringify(port)})`,
          file,
        )
      }
      out.port = port
    }
  }

  if ('workers' in root) {
    const workers = root.workers
    if (workers === null || typeof workers !== 'object') {
      throw new BrustConfigError(`${file}: [workers] must be a table`, file)
    }
    const count = (workers as Record<string, unknown>).count
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        throw new BrustConfigError(
          `${file}: workers.count must be a positive integer (got ${JSON.stringify(count)})`,
          file,
        )
      }
      out.workers = count
    }
  }

  if ('cache' in root) {
    const cache = root.cache
    if (cache === null || typeof cache !== 'object') {
      throw new BrustConfigError(`${file}: [cache] must be a table`, file)
    }
    const maxEntries = (cache as Record<string, unknown>).max_entries
    if (maxEntries !== undefined) {
      if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1) {
        throw new BrustConfigError(
          `${file}: cache.max_entries must be a positive integer (got ${JSON.stringify(maxEntries)})`,
          file,
        )
      }
      out.cacheMaxEntries = maxEntries
    }
  }

  return out
}

function extractFromEnv(): Partial<BrustConfig> {
  const out: Partial<BrustConfig> = {}
  if (process.env.BRUST_PORT) {
    const n = parseInt(process.env.BRUST_PORT, 10)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new BrustConfigError(
        `BRUST_PORT must be an integer in 1..65535 (got ${JSON.stringify(process.env.BRUST_PORT)})`,
        null,
      )
    }
    out.port = n
  }
  if (process.env.BRUST_WORKERS) {
    const n = parseInt(process.env.BRUST_WORKERS, 10)
    if (!Number.isInteger(n) || n < 1) {
      throw new BrustConfigError(
        `BRUST_WORKERS must be a positive integer (got ${JSON.stringify(process.env.BRUST_WORKERS)})`,
        null,
      )
    }
    out.workers = n
  }
  return out
}
