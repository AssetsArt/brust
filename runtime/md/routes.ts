import { createHash } from 'node:crypto'

/**
 * Content-addressed jinja template name for an md page:
 * `Md_<sanitized relPath>_<8hex(sha256 relPath)>`.
 *
 * Sanitizes `[^A-Za-z0-9_]` to `_`; the hash (same scheme as
 * `islandChunkBasename` in runtime/islands/chunk-id.ts) keeps two relPaths
 * that sanitize identically (e.g. `a-b.md` vs `a_b.md`) from colliding.
 */
export function mdTemplateName(relPath: string): string {
  const sanitized = relPath.replace(/[^A-Za-z0-9_]/g, '_')
  const hash = createHash('sha256').update(relPath).digest('hex').slice(0, 8)
  return `Md_${sanitized}_${hash}`
}

/**
 * Maps a content-relative md path to its URL under `prefix`.
 * `index.md` maps to the prefix itself; `guide/index.md` maps to
 * `<prefix>/guide`; `query/where.md` maps to `<prefix>/query/where`.
 * Trailing slashes on `prefix` are normalized away (`/docs/` == `/docs`).
 */
export function mdUrlPath(relPath: string, prefix: string): string {
  let base = prefix.replace(/\/+$/, '')
  if (base !== '' && !base.startsWith('/')) base = `/${base}`
  let route = relPath.replace(/\.md$/, '')
  if (route === 'index') route = ''
  else if (route.endsWith('/index')) route = route.slice(0, -'/index'.length)
  const url = route === '' ? base : `${base}/${route}`
  return url === '' ? '/' : url
}
