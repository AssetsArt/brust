// `wrangler.jsonc` for `dist/cf/` (M4-CF R5, R6, R7): the user's app-root config merged with the keys brust owns.
// Pure apart from `readUserWrangler`. Never adds an `account_id`; copies one only if the user wrote it.
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { BuildError } from './errors'

type Json = Record<string, unknown>
export interface UserWrangler {
  file: string | null
  config: Json
}

export interface MergeOpts {
  appRoot: string
  cfDir: string
  /** `[cloudflare] name` */
  name?: string
  pkgName?: string
  compatibilityDate: string
  /** worker-build entry, relative to `worker/` (core-cf `brust.main`) */
  main: string
  version: string
}

const OWNED = ['main', 'assets', 'compatibility_date', 'no_bundle', 'find_additional_modules', 'base_dir', 'rules', 'build', 'site']
const CONFIG_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']

export async function readUserWrangler(appRoot: string): Promise<UserWrangler> {
  const found = CONFIG_FILES.filter((f) => existsSync(join(appRoot, f)))
  if (found.length > 1) throw new BuildError('cf-config', `more than one wrangler config in ${appRoot}: ${found.join(', ')} — keep one`)
  const f = found[0]
  if (!f) return { file: null, config: {} }
  const text = await Bun.file(join(appRoot, f)).text()
  try {
    const parsed = f.endsWith('.toml') ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)
    return { file: f, config: (parsed ?? {}) as Json }
  } catch (e) {
    throw new BuildError('cf-config', `failed to parse ${join(appRoot, f)}: ${(e as Error).message}`)
  }
}

const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

/** package.json `name` -> a Worker name: scope dropped, lowercased, non-[a-z0-9-] -> `-`, <= 63. */
export function workerNameOf(pkgName: string): string {
  return pkgName.replace(/^@[^/]*\//, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
}

function rebase(o: MergeOpts, p: string): string {
  return isAbsolute(p) ? p : relative(o.cfDir, join(o.appRoot, p))
}

function assertNoAssetsBinding(v: unknown, path: string): void {
  if (Array.isArray(v)) return v.forEach((x, i) => assertNoAssetsBinding(x, `${path}[${i}]`))
  if (!isObj(v)) return
  for (const [k, x] of Object.entries(v)) {
    if (k === 'assets' && path === '') continue
    if ((k === 'binding' || (k === 'name' && /durable_objects/.test(path))) && x === 'ASSETS') throw new BuildError('cf-config', `wrangler config: a binding named ASSETS (${path || 'root'}) clashes with brust's static-assets binding`)
    if (k === 'vars' && isObj(x) && 'ASSETS' in x) throw new BuildError('cf-config', 'wrangler config: vars.ASSETS clashes with brust\'s static-assets binding')
    assertNoAssetsBinding(x, `${path}.${k}`)
  }
}

function rebasePaths(o: MergeOpts, block: Json): void {
  if (Array.isArray(block.d1_databases))
    for (const d of block.d1_databases)
      if (isObj(d)) d.migrations_dir = rebase(o, typeof d.migrations_dir === 'string' ? d.migrations_dir : 'migrations')
  if (typeof block.tsconfig === 'string') block.tsconfig = rebase(o, block.tsconfig)
  if (isObj(block.alias))
    for (const [k, v] of Object.entries(block.alias)) if (typeof v === 'string' && v.startsWith('.')) block.alias[k] = rebase(o, v)
}

function checkFlags(block: Json, where: string): void {
  if (Array.isArray(block.compatibility_flags) && block.compatibility_flags.some((f) => typeof f === 'string' && /^no_nodejs_compat/.test(f)))
    throw new BuildError('cf-config', `wrangler config${where}: compatibility_flags "no_nodejs_compat*" is not allowed (AsyncLocalStorage needs nodejs_compat)`)
}

export function mergeWrangler(user: UserWrangler, o: MergeOpts): { config: Json; warnings: string[] } {
  const warnings: string[] = []
  const src = structuredClone(user.config)
  assertNoAssetsBinding(src, '')
  checkFlags(src, '')
  const owned = (k: string, where: string) => warnings.push(`[brust] wrangler: ${where}${k} is owned by brust build --target cloudflare; ignored`)
  const rest: Json = {}
  for (const [k, v] of Object.entries(src)) {
    if (OWNED.includes(k)) owned(k, '')
    else rest[k] = v
  }
  const userName = typeof rest.name === 'string' ? rest.name : undefined
  if (o.name !== undefined && userName !== undefined && userName !== o.name)
    warnings.push(`[brust] wrangler: name "${userName}" conflicts with [cloudflare] name "${o.name}"; brust.toml wins`)
  const name = o.name ?? userName ?? (o.pkgName ? workerNameOf(o.pkgName) : undefined)
  rebasePaths(o, rest)
  if (isObj(rest.env))
    for (const [en, eb] of Object.entries(rest.env)) {
      if (!isObj(eb)) continue
      checkFlags(eb, ` env.${en}`)
      for (const k of OWNED)
        if (k in eb) {
          owned(k, `env.${en}.`)
          delete eb[k]
        }
      rebasePaths(o, eb)
    }
  const config: Json = {
    ...(name !== undefined ? { name } : {}),
    main: `worker/${o.main}`,
    compatibility_date: o.compatibilityDate,
    assets: { directory: 'assets', binding: 'ASSETS', run_worker_first: false, html_handling: 'none', not_found_handling: 'none' },
    ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'name')),
  }
  return { config, warnings }
}

export interface CacheNeed {
  kv?: string
  do?: string
}

const KV_SNIPPET = (b: string) => `"kv_namespaces": [{ "binding": "${b}", "id": "<wrangler kv namespace create brust-cache>" }]`
const DO_SNIPPET = (b: string) =>
  `"durable_objects": { "bindings": [{ "name": "${b}", "class_name": "BrustCacheDO" }] },\n  "migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]`

/** Does `block` declare BrustCacheDO as a SQLite class (migrations or `exports`)? `'kv'` = declared only as a KV-backed `new_classes`. */
function declaresDoClass(block: Json): boolean | 'kv' {
  if (Array.isArray(block.migrations)) {
    let kvBacked = false
    for (const m of block.migrations) {
      if (!isObj(m)) continue
      if (Array.isArray(m.new_sqlite_classes) && m.new_sqlite_classes.includes('BrustCacheDO')) return true
      if (Array.isArray(m.new_classes) && m.new_classes.includes('BrustCacheDO')) kvBacked = true
    }
    if (kvBacked) return 'kv'
  }
  const e = isObj(block.exports) ? block.exports.BrustCacheDO : undefined
  return isObj(e) && e.type === 'durable-object' && e.storage === 'sqlite'
}

/**
 * R10: the user's wrangler config (top level and every `env.<name>`) must declare the bindings the configured Cloudflare cache needs. Nothing is
 * added for them. A class declaration (`migrations` / `exports`) is also accepted from the top level for an env block. Pure; `config` is not mutated.
 */
export function verifyCacheBindings(config: Json, need: CacheNeed): { ok: true } | { ok: false; message: string } {
  const problems: string[] = []
  const blocks: [string, Json][] = [['the top level', config]]
  if (isObj(config.env)) for (const [n, b] of Object.entries(config.env)) if (isObj(b)) blocks.push([`env.${n}`, b])
  for (const [where, b] of blocks) {
    if (need.kv !== undefined) {
      const ok = Array.isArray(b.kv_namespaces) && b.kv_namespaces.some((k) => isObj(k) && k.binding === need.kv)
      if (!ok) problems.push(`wrangler config ${where}: no kv_namespaces binding "${need.kv}". Add:\n  ${KV_SNIPPET(need.kv)}`)
    }
    if (need.do !== undefined) {
      const bound = isObj(b.durable_objects) && Array.isArray(b.durable_objects.bindings) && b.durable_objects.bindings.some((d) => isObj(d) && d.name === need.do && d.class_name === 'BrustCacheDO' && d.script_name === undefined)
      if (!bound) problems.push(`wrangler config ${where}: no durable_objects binding { "name": "${need.do}", "class_name": "BrustCacheDO" } (without script_name). Add:\n  ${DO_SNIPPET(need.do)}`)
      else {
        const decl = declaresDoClass(b) || (where === 'the top level' ? false : declaresDoClass(config))
        if (decl === 'kv') problems.push(`wrangler config ${where}: BrustCacheDO is declared with new_classes (KV-backed, no SQL API); use new_sqlite_classes:\n  "migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]`)
        else if (decl !== true) problems.push(`wrangler config ${where}: BrustCacheDO is not declared. Add:\n  "migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]`)
      }
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, message: problems.join('\n') }
}

export function renderWrangler(config: Json): string {
  return `// generated by \`brust build --target cloudflare\` — edit the app-root wrangler config instead\n${JSON.stringify(config, null, 2)}\n`
}
