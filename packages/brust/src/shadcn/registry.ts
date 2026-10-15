// F228: a registry URL given to `brust shadcn init` names a third-party item that declares its own file targets, known
// only once the item is fetched. This fetches the item JSON BEFORE the shadcn CLI is spawned (https only, a size cap, a
// timeout, redirects followed by hand and only to https) and checks every path it can make the CLI write. The command
// then hands the CLI the file it checked, not the URL, so the item cannot change between the check and the write.

/** The most bytes of item JSON read; a bigger answer is refused. */
export const ITEM_MAX_BYTES = 1024 * 1024
/** The whole fetch (redirects included) gets this long. */
export const ITEM_TIMEOUT_MS = 15_000
/** Redirects followed by hand; each target must be https. */
export const MAX_REDIRECTS = 3

export interface FetchOptions {
  /** URL schemes allowed for the request and every redirect. Default `https:` only; a test passes `http:` for a local server. */
  schemes?: string[]
  maxBytes?: number
  timeoutMs?: number
}

/** Fetches `url` and returns the body text, or throws an `Error` whose message is the reason it was refused. */
export async function fetchRegistryItem(url: string, o: FetchOptions = {}): Promise<string> {
  const schemes = o.schemes ?? ['https:']
  const maxBytes = o.maxBytes ?? ITEM_MAX_BYTES
  const signal = AbortSignal.timeout(o.timeoutMs ?? ITEM_TIMEOUT_MS)
  let cur = url
  try {
    for (let hop = 0; ; hop++) {
      let u: URL
      try {
        u = new URL(cur)
      } catch {
        throw new Error(`${cur} is not a URL`)
      }
      if (!schemes.includes(u.protocol)) throw new Error(`${cur} is not an ${schemes.join(' or ').replace(/:/g, '')} URL`)
      if (u.username !== '' || u.password !== '') throw new Error(`${u.origin}${u.pathname} carries credentials in the URL`)
      const res = await fetch(u, { redirect: 'manual', signal, headers: { accept: 'application/json' } })
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location')
        await res.body?.cancel()
        if (!next) throw new Error(`${cur} answered ${res.status} with no Location`)
        if (hop >= MAX_REDIRECTS) throw new Error(`${url} redirects more than ${MAX_REDIRECTS} times`)
        cur = new URL(next, u).toString() // the next loop turn refuses a non-https target
        continue
      }
      if (!res.ok) {
        await res.body?.cancel()
        throw new Error(`${cur} answered HTTP ${res.status}`)
      }
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel()
        throw new Error(`${cur} is ${declared} bytes; the limit is ${maxBytes}`)
      }
      const reader = res.body?.getReader()
      if (!reader) return ''
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > maxBytes) {
          await reader.cancel()
          throw new Error(`${cur} is bigger than the limit of ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    }
  } catch (e) {
    if (signal.aborted) throw new Error(`${url} did not answer within ${(o.timeoutMs ?? ITEM_TIMEOUT_MS) / 1000} s`)
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/** True for a path that is not a plain relative path: absolute, a drive, a backslash, a NUL, a control character or `..`. */
export function unsafeRel(p: string): boolean {
  return p === '' || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\\') || /[\x00-\x1f]/.test(p) || p.split('/').some((s) => s === '..') || (p.includes('%') && /%2e|%2f|%5c|%00/i.test(p))
}

export interface VettedItem {
  /** Project-relative paths the CLI may write for this item, beyond the alias directories (checked for symlinks). */
  paths: string[]
}

const PLAIN_NAME = /^[a-z0-9][a-z0-9-]*$/

/** The top-level keys of an item in the pinned registry schema (`@shadcn/registry` 0.1.3). Allowlist, not denylist: a key
 *  this does not name (`font`, which makes the CLI write the CSS entry and a layout file, or one a later schema adds) is a
 *  refusal, because the CLI could write something this never judged. */
const ITEM_KEYS = new Set(['$schema', 'extends', 'name', 'type', 'title', 'author', 'description', 'dependencies', 'devDependencies', 'registryDependencies', 'files', 'tailwind', 'cssVars', 'css', 'envVars', 'meta', 'docs', 'categories'])
/** Item types whose files the CLI rewrites to a framework path (`registry:page`) or whose write set is not judged (`registry:font`). */
const REFUSED_TYPES = new Set(['registry:font', 'registry:page'])

/**
 * Judges item JSON: the file targets it declares and the other things it makes the CLI write or fetch. Returns the
 * paths to check for symlinks, or the reason it is refused. Fail closed: anything it cannot judge is a refusal.
 */
export function vetItem(text: string, cssEntry: string): VettedItem | { error: string } {
  let item: unknown
  try {
    item = JSON.parse(text)
  } catch {
    return { error: 'is not valid JSON' }
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return { error: 'is not a JSON object' }
  const o = item as Record<string, unknown>
  if (o.type !== undefined && (typeof o.type !== 'string' || REFUSED_TYPES.has(o.type))) return { error: `is of type ${JSON.stringify(o.type)}, whose files the CLI places by rules this check does not model` }
  const unknown = Object.keys(o).find((k) => !ITEM_KEYS.has(k))
  if (unknown !== undefined) return { error: `has the key ${JSON.stringify(unknown)}, which this check does not know; it may make the CLI write files that cannot be checked` }
  const paths: string[] = []
  if (o.files !== undefined) {
    if (!Array.isArray(o.files)) return { error: '"files" is not an array' }
    for (const f of o.files) {
      if (typeof f !== 'object' || f === null) return { error: 'has a file entry that is not an object' }
      const { path, target } = f as { path?: unknown; target?: unknown }
      if (path !== undefined && typeof path !== 'string') return { error: 'has a file with a "path" that is not a string' }
      if (target !== undefined && typeof target !== 'string') return { error: 'has a file with a "target" that is not a string' }
      if (typeof path === 'string' && unsafeRel(path)) return { error: `declares the file path ${JSON.stringify(path)}, which is not a plain path inside the project` }
      if (typeof target === 'string' && target !== '') {
        // The CLI's own rules (resolveFilePath): `~/x` is project-relative; `@components|ui|lib|hooks/x` is inside that alias
        // directory (scanned already); any other target is joined to the project root, once as written and, in a `src/`
        // project, under `src/` (it drops one `src/` from the target either way). All of them are checked.
        const t = target.startsWith('~/') ? target.slice(2) : target
        const alias = /^@(components|ui|lib|hooks)\/(.+)$/.exec(t)
        if (alias) {
          if (unsafeRel(alias[2]!)) return { error: `declares the file target ${JSON.stringify(target)}, which is not a plain path inside the project` }
        } else {
          const rel = t.replace(/^@([^/]+)\//, '$1/')
          if (unsafeRel(rel)) return { error: `declares the file target ${JSON.stringify(target)}, which is not a plain path inside the project` }
          const bare = rel.replace('src/', '')
          paths.push(rel, bare, `src/${bare}`)
        }
      }
    }
  }
  // what else the CLI writes: the Tailwind CSS entry (css, cssVars), env files (envVars)
  if (o.css !== undefined || o.cssVars !== undefined || o.tailwind !== undefined) paths.push(cssEntry)
  if (o.envVars !== undefined) paths.push('.env', '.env.local')
  // dependencies on other items the CLI would fetch after this check (a `config` that would merge into components.json is an unknown key, refused above)
  const deps = [...(Array.isArray(o.registryDependencies) ? o.registryDependencies : o.registryDependencies === undefined ? [] : [null]), ...(o.extends === undefined ? [] : [o.extends])]
  for (const d of deps) {
    if (typeof d !== 'string') return { error: 'has a registryDependencies / extends entry that is not a string' }
    if (!PLAIN_NAME.test(d)) {
      return { error: `depends on ${JSON.stringify(d)}, which the CLI would fetch after this check; pass that URL to the command as its own argument so it is checked too` }
    }
  }
  return { paths }
}
