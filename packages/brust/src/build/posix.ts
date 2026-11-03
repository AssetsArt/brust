// F485 (G5): the one choke point for path spelling. A path that leaves the filesystem layer (handed to the native
// compiler, used as a Map/manifest key, matched against config prefixes, written into dist/*.js, dev.json or a wrangler
// config) is `/`-separated; a path used only for fs calls stays native. Every helper takes the separator as a parameter
// (default: the platform's), so a unit test can feed `C:\app\pages\X.tsx` on any OS and POSIX output stays byte-identical.
import { isAbsolute, relative, sep } from 'node:path'

/** `p` with the platform separator spelled `/`. A no-op on POSIX (a `\` there is a legal file name character). */
export function posixOf(p: string, s: string = sep): string {
  return s === '/' ? p : p.split(s).join('/')
}

/** The reverse of {@link posixOf}: a `/`-separated path (the compiler's spelling) as the platform spells it. */
export function nativeOf(p: string, s: string = sep): string {
  return s === '/' ? p : p.split('/').join(s)
}

/** `relative(base, file)` spelled with `/`. */
export function relPosix(base: string, file: string, s: string = sep): string {
  return posixOf(relative(base, file), s)
}

/** A `relative()` result that does not lie inside its base: `..`, `../x`, or an absolute path (another drive on Windows). */
export function escapes(rel: string, s: string = sep): boolean {
  const p = posixOf(rel, s)
  return p === '..' || p.startsWith('../') || isAbsolute(rel) || /^[A-Za-z]:/.test(p)
}

/** `[build] server_only` (spec §8.2): is the app-root-relative `rel` inside a listed prefix? Prefixes are `/`-spelled
 * (config.ts normalises them); `rel` is spelled with `s` and normalised here, so a Windows `lib\server\db.ts` matches
 * `lib/server`. A path outside the app root never matches. */
export function inServerOnlyPrefix(rel: string, prefixes: string[], s: string = sep): boolean {
  if (escapes(rel, s)) return false
  const p = posixOf(rel, s)
  return prefixes.some((pre) => p.startsWith(pre))
}
