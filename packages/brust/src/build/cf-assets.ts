// Static assets for Workers Static Assets (M4-CF R7): only files the native host would serve (`safe_rel` in
// `crates/brust-core/src/static_rules.rs`), laid out under the URL they are requested at, plus `_headers`.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SEG = /^[A-Za-z0-9_.-]+$/
const IMMUTABLE = 'public, max-age=31536000, immutable'
const PUBLIC_DEFAULT = 'public, max-age=3600'
const MAX_RULES = 100

/** `static_rules.rs` `is_hashed`: the stem ends in `-<hex6+>` (lowercase) with at least one digit. */
export function isHashed(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const i = stem.lastIndexOf('-')
  if (i < 0) return false
  const h = stem.slice(i + 1)
  return h.length >= 6 && /^[0-9a-f]+$/.test(h) && /\d/.test(h)
}

const segOk = (s: string) => s !== '' && !s.startsWith('.') && SEG.test(s)

/** `client/<file>.js|.css`: `is_safe_island_filename` / `is_safe_css_filename`. */
const clientOk = (f: string) => segOk(f) && !f.includes('..') && (f.endsWith('.js') || f.endsWith('.css'))

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), r))
    else if (e.isFile() || statSync(join(dir, e.name)).isFile()) out.push(r)
  }
  return out.sort()
}

/** Copies the admissible files of `<out>/client` and `<out>/public` into `<cfDir>/assets/...`; returns the
 * asset-relative paths (`_brust/client/x.js`, `public/img/a.png`) and writes `assets/_headers`. */
export function layoutAssets(out: string, cfDir: string, version: string): { files: string[]; warnings: string[] } {
  const assets = join(cfDir, 'assets')
  mkdirSync(assets, { recursive: true })
  const files: string[] = []
  const warnings: string[] = []
  const copy = (from: string, to: string) => {
    mkdirSync(dirname(join(assets, to)), { recursive: true })
    cpSync(from, join(assets, to))
    files.push(to)
  }
  const client = join(out, 'client')
  if (existsSync(client))
    for (const f of walk(client)) {
      if (!f.includes('/') && clientOk(f)) copy(join(client, f), `_brust/client/${f}`)
      else warnings.push(`[brust] assets: client/${f} is not served natively; skipped`)
    }
  const pub = join(out, 'public')
  if (existsSync(pub))
    for (const f of walk(pub)) {
      if (f.split('/').every(segOk)) copy(join(pub, f), `public/${f}`)
      else warnings.push(`[brust] assets: public/${f} has a name the native host would not serve; skipped`)
    }
  const h = headersFile(files, version)
  warnings.push(...h.warnings)
  writeFileSync(join(assets, '_headers'), h.text)
  return { files, warnings }
}

export function headersFile(files: string[], version: string): { text: string; warnings: string[] } {
  const warnings: string[] = []
  const rules: string[] = [
    `/*\n  X-Content-Type-Options: nosniff\n  X-Powered-By: brust/${version}`,
    `/_brust/client/*\n  Cache-Control: ${IMMUTABLE}`,
  ]
  const pub = files.filter((f) => f.startsWith('public/'))
  if (rules.length + pub.length <= MAX_RULES)
    for (const f of pub) rules.push(`/${f}\n  Cache-Control: ${isHashed(f) ? IMMUTABLE : PUBLIC_DEFAULT}`)
  else if (pub.length > 0) {
    rules.push(`/public/*\n  Cache-Control: ${PUBLIC_DEFAULT}`)
    warnings.push(`[brust] assets: ${pub.length} public files exceed the 100-rule _headers limit; one /public/* max-age=3600 rule (no per-file immutable)`)
  }
  return { text: `${rules.join('\n\n')}\n`, warnings }
}
