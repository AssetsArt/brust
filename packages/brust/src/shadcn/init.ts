// `brust shadcn init [component ...]`: sets a brust project up for shadcn/ui and adds components (F175, R41.1-R41.10).
// shadcn's own `init` does not detect brust, so this writes what `add` needs (components.json, the `@/*` path),
// installs the four packages the components import, and runs ONE pinned shadcn CLI for the theme and the components.
// Every child process is spawned from an argv array, never through a shell; the runner is injected for tests.
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type Member, type ObjectNode, raw, readObject } from './jsonc'
import { fetchRegistryItem, vetItem } from './registry'

/** The shadcn CLI version this command runs (R41.6). A release that moves it re-runs the transcript. */
export const SHADCN_VERSION = '4.21.4'

/**
 * The packages the components import (R41.5), each pinned to the exact version the transcript ran
 * (`docs/transcripts/shadcn-init-guide.md`, F181). They move together with `SHADCN_VERSION`: a release that moves one
 * re-runs the transcript. A package the project already depends on, at any version, is left alone.
 */
export const SHADCN_DEP_PINS = {
  'radix-ui': '1.8.1',
  'lucide-react': '1.57.0',
  'class-variance-authority': '0.7.1',
  'tw-animate-css': '1.4.0',
} as const
export const SHADCN_DEPS = Object.keys(SHADCN_DEP_PINS) as (keyof typeof SHADCN_DEP_PINS)[]

/** Runs `argv` in `cwd` with the terminal attached; resolves to the exit code. Never a shell string. */
export type Runner = (argv: string[], cwd: string) => Promise<number>

export interface InitOptions {
  /** Project root (cwd). */
  root: string
  components: string[]
  force?: boolean
  css?: string
  baseColor?: string
  shadcnVersion?: string
  run: Runner
  out: (line: string) => void
  /** F228: fetches the JSON of a registry URL item (default: `fetchRegistryItem`, https only); injected for tests. */
  fetchItem?: (url: string) => Promise<string>
}

const COMPONENT = /^[a-z0-9][a-z0-9-]*$/
const REGISTRY_URL = /^https:\/\/[^\s]+$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const COLOR = /^[a-z]+$/

/** True for a symlink, also a dangling one (`existsSync` follows links and says false for those). */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** True when `rel` (project-relative), or any directory on the way to it, is a symlink. */
function linkUnder(root: string, rel: string): boolean {
  let cur = root
  for (const seg of rel.split('/').filter(Boolean)) {
    cur = join(cur, seg)
    if (isLink(cur)) return true
  }
  return false
}

type PathsMap = Array<[string, string[]]>

/** What one tsconfig file says on its own: `baseUrl` (absolute), `paths` and the directory they are declared in (a `paths`
 *  entry is relative to `baseUrl`, else to the file that declares it), and its `extends` specifiers. */
interface TsFile {
  baseUrl?: string
  paths?: { dir: string; map: PathsMap }
  extends: string[]
}

const EXTENDS_DEPTH = 20

function readJsonc(file: string): { text: string; top: ObjectNode } | { error: string } {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { error: `cannot read ${file}` }
  }
  try {
    return { text, top: readObject(text) }
  } catch (e) {
    return { error: `cannot parse ${file} (${(e as Error).message})` }
  }
}

/** The strings inside a member's raw value (a string, or an array of strings). */
function strings(text: string, m: Member | undefined): string[] {
  return m ? [...raw(text, m).matchAll(/"([^"\\]*)"/g)].map((x) => x[1] ?? '') : []
}

function tsFile(file: string): TsFile | { error: string } {
  const r = readJsonc(file)
  if ('error' in r) return r
  const { text, top } = r
  const ext = top.members.find((m) => m.key === 'extends')
  const extendsList = strings(text, ext)
  if (ext && (extendsList.length === 0 || extendsList.some((x) => x === ''))) return { error: `${file}: "extends" must be a path or a list of paths` }
  const co = top.members.find((m) => m.key === 'compilerOptions')?.object
  const out: TsFile = { extends: extendsList }
  const baseMember = co?.members.find((m) => m.key === 'baseUrl')
  const pathsMember = co?.members.find((m) => m.key === 'paths')
  if (pathsMember && !pathsMember.object) return { error: `${file}: compilerOptions.paths is not an object` }
  const all = [...extendsList, ...strings(text, baseMember), ...(pathsMember?.object?.members.flatMap((m) => [m.key, ...strings(text, m)]) ?? [])]
  if (all.some((x) => x.includes('${'))) return { error: `${file} uses a \${...} template in extends, baseUrl or paths; the shadcn CLI target paths cannot be checked` }
  if (baseMember) out.baseUrl = resolve(dirname(file), strings(text, baseMember)[0] ?? '')
  if (pathsMember?.object) out.paths = { dir: dirname(file), map: pathsMember.object.members.map((m): [string, string[]] => [m.key, strings(text, m)]) }
  return out
}

/** The file an `extends` specifier names, the way TypeScript finds it: a relative or absolute path (with or without
 *  `.json`), else a package config under the nearest `node_modules` (`pkg`, `pkg/sub`, `pkg/file.json`). */
function resolveExtends(from: string, spec: string): string | undefined {
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  const tryFile = (p: string): string | undefined => [p, `${p}.json`, join(p, 'tsconfig.json')].find(isFile)
  if (spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec)) return tryFile(resolve(dirname(from), spec))
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const cand = join(dir, 'node_modules', spec)
    const hit = tryFile(cand)
    if (hit) return hit
    // a package whose package.json names its config: "tsconfig": "./x.json"
    try {
      const field = (JSON.parse(readFileSync(join(cand, 'package.json'), 'utf8')) as { tsconfig?: unknown }).tsconfig
      if (typeof field === 'string') {
        const f = tryFile(resolve(cand, field))
        if (f) return f
      }
    } catch {}
    if (dirname(dir) === dir) return undefined
  }
}

/** The `baseUrl` and `paths` a tsconfig ends up with once its `extends` chain is folded (later entries win; the file's
 *  own `paths` replace inherited ones whole, as TypeScript does). `inherited` is true when the `paths` come from a parent. */
function effectivePaths(file: string, trail: string[]): { baseUrl?: string; paths?: { dir: string; map: PathsMap }; inherited: boolean } | { error: string } {
  if (trail.includes(file)) return { error: `${file} extends itself (a cycle)` }
  if (trail.length >= EXTENDS_DEPTH) return { error: `the tsconfig "extends" chain is more than ${EXTENDS_DEPTH} files long` }
  const own = tsFile(file)
  if ('error' in own) return own
  let baseUrl: string | undefined
  let paths: { dir: string; map: PathsMap } | undefined
  for (const spec of own.extends) {
    const parent = resolveExtends(file, spec)
    if (parent === undefined) return { error: `${file}: cannot resolve "extends" ${JSON.stringify(spec)}, so the paths the shadcn CLI will use cannot be read` }
    const eff = effectivePaths(parent, [...trail, file])
    if ('error' in eff) return eff
    if (eff.baseUrl !== undefined) baseUrl = eff.baseUrl
    if (eff.paths) paths = eff.paths
  }
  const inheritedPaths = own.paths === undefined && paths !== undefined
  if (own.baseUrl !== undefined) baseUrl = own.baseUrl
  if (own.paths) paths = own.paths
  return { ...(baseUrl !== undefined && { baseUrl }), ...(paths && { paths }), inherited: inheritedPaths }
}

/** F226: `paths` and the project-relative directory they resolve from, read through the whole `extends` chain of
 *  `tsconfig.json`. An error when a file of the chain cannot be read or found (fail closed: nothing is assumed). A
 *  tsconfig that is not parseable at all keeps its old meaning (R41.4: not touched, the line is printed). */
function tsconfigPaths(root: string, file: string): { base: string; map: PathsMap; inherited: boolean } | { error: string } {
  const top = readJsonc(file)
  if ('error' in top) return { base: '', map: [], inherited: false }
  const eff = effectivePaths(file, [])
  if ('error' in eff) return eff
  const from = eff.baseUrl ?? eff.paths?.dir ?? root
  const base = relative(root, from).split(sep).join('/')
  return { base, map: eff.paths ? eff.paths.map.map(([k, v]): [string, string[]] => [k, [...v]]) : [], inherited: eff.inherited }
}

/** A project-relative path for an import alias (`@/hooks` → `hooks`) by the tsconfig `paths`, or undefined when no entry
 *  matches or the result is not a plain path inside the project (absolute, `..`, a drive, a backslash). */
function resolveAlias(alias: string, base: string, map: Array<[string, string[]]>): string[] | undefined {
  let best: { rank: number; targets: string[] } | undefined
  for (const [key, targets] of map) {
    const star = key.indexOf('*')
    let rest: string | undefined
    if (star < 0) rest = key === alias ? '' : undefined
    else if (alias.length >= key.length - 1 && alias.startsWith(key.slice(0, star)) && alias.endsWith(key.slice(star + 1))) rest = alias.slice(star, alias.length - (key.length - star - 1))
    if (rest === undefined || targets.length === 0) continue
    const rank = star < 0 ? Number.MAX_SAFE_INTEGER : star
    if (!best || rank > best.rank) best = { rank, targets: targets.map((t) => (star < 0 ? t : t.replace('*', rest))) }
  }
  if (!best) return undefined
  const out: string[] = []
  for (const t of best.targets) {
    const segs = `${base}/${t}`.split('/').filter((x) => x !== '' && x !== '.')
    if (t === '' || segs.some((x) => x === '..' || x.includes('\\') || x.includes(':')) || t.startsWith('/') || base.startsWith('/')) return undefined
    out.push(segs.join('/'))
  }
  return out
}

/** F193: every path the shadcn CLI may write, project-relative, or an error. The CLI follows symlinks, so the caller
 *  refuses when one is, or sits under, a symlink. Fails closed: an alias that cannot be resolved by the tsconfig `paths`
 *  (read through `extends`, F226; `@/*` → `./*` is assumed only when no `@/*` is there and none is inherited: it is what
 *  this command adds) is an error, not a skipped check. */
function cliTargets(
  componentsText: string | undefined,
  ts: { base: string; map: PathsMap; inherited: boolean } | undefined,
  css: string | undefined,
  components: string[],
): { paths: string[]; dirs: string[] } | { error: string } {
  let aliases: Record<string, string> = { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui', lib: '@/lib', hooks: '@/hooks' }
  if (componentsText !== undefined) {
    try {
      const a = (JSON.parse(componentsText) as { aliases?: unknown }).aliases
      if (a !== undefined) {
        if (typeof a !== 'object' || a === null || Array.isArray(a)) return { error: 'components.json "aliases" is not an object' }
        aliases = {}
        for (const [k, v] of Object.entries(a)) {
          if (typeof v !== 'string') return { error: `components.json alias ${JSON.stringify(k)} is not a string` }
          aliases[k] = v
        }
      }
    } catch {
      return { error: 'components.json is not valid JSON, so the shadcn CLI target paths cannot be checked' }
    }
  }
  const base = ts?.base ?? ''
  const map: PathsMap = ts ? [...ts.map] : []
  // `@/*` → `./*` is the mapping this command adds when the tsconfig has no `@/*` of its own. When the `paths` are
  // inherited through `extends` nothing is added (the file would then replace them), so only what the chain says counts.
  if (!ts?.inherited && !map.some(([k]) => k === '@/*')) map.push(['@/*', ['./*']])
  const paths: string[] = []
  const dirs: string[] = []
  const roots: Record<string, string> = {}
  for (const [k, v] of Object.entries(aliases)) {
    const rels = resolveAlias(v, base, map)
    if (rels === undefined || rels.length === 0 || rels.includes('')) return { error: `alias ${JSON.stringify(k)} (${JSON.stringify(v)}) in components.json does not resolve to a path inside the project by the tsconfig "paths"; the shadcn CLI target cannot be checked` }
    roots[k] = rels[0]!
    for (const rel of rels) {
      if (k === 'utils') paths.push(rel, `${rel}.ts`)
      else {
        paths.push(rel)
        dirs.push(rel)
      }
    }
  }
  const ui = roots.ui ?? 'components/ui'
  return { paths: [...paths, 'package.json', ...(css === undefined ? [] : [css]), ...components.filter((c) => COMPONENT.test(c)).map((c) => `${ui}/${c}.tsx`)], dirs }
}

/** F227: the most entries `cliLink` looks at under the alias directories before it refuses (no fixed depth: a link at
 *  any depth is found; a tree this big is not a components directory). */
export const SCAN_LIMIT = 10_000

/** Where a path or directory entry the CLI could write through is a symlink (`link`), or the directory walk hit its
 *  entry bound (`tooMany`); undefined when clean. */
function cliLink(root: string, t: { paths: string[]; dirs: string[] }): { link: string } | { tooMany: string } | undefined {
  const hit = t.paths.find((p) => linkUnder(root, p))
  if (hit !== undefined) return { link: hit }
  // dependency files of a registry item (hooks, lib helpers) land in these directories: no entry may be a link
  let seen = 0
  const scan = (rel: string): { link: string } | { tooMany: string } | undefined => {
    let names: string[]
    try {
      names = readdirSync(join(root, rel))
    } catch {
      return undefined // not a directory, or it does not exist yet (the CLI creates it): nothing to follow
    }
    for (const e of names) {
      const sub = `${rel}/${e}`
      if (++seen > SCAN_LIMIT) return { tooMany: rel }
      if (isLink(join(root, sub))) return { link: sub }
      const found = scan(sub)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const d of t.dirs) {
    const found = scan(d)
    if (found !== undefined) return found
  }
  return undefined
}

/** The name a registry URL installs: its last path segment without `.json`; undefined when it is not a plain name. */
function urlItemName(url: string): string | undefined {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/\.json$/, '')
    return seg !== undefined && COMPONENT.test(seg) ? seg : undefined
  } catch {
    return undefined
  }
}

/** The `components.json` of the tested fixture (`tests/fixtures/shadcn/components.json`), for `css` and `baseColor` (R41.2). */
export function componentsJson(css: string, baseColor: string): string {
  return `{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": ${JSON.stringify(css)}, "baseColor": ${JSON.stringify(baseColor)}, "cssVariables": true, "prefix": "" },
  "iconLibrary": "lucide",
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" }
}
`
}

export type PathEdit =
  | { kind: 'added'; text: string }
  | { kind: 'present' }
  | { kind: 'other'; target: string }
  | { kind: 'unparseable'; why: string }

const ENTRY = '"@/*": ["./*"]'

/** F226: the `paths` come from an extended file, so the file is not edited (an own `paths` would replace them whole):
 *  the inherited `@/*` is judged like an own one. */
function inheritedEdit(ts: { base: string; map: PathsMap }): PathEdit {
  const hit = ts.map.find(([k]) => k === '@/*')
  if (!hit) return { kind: 'unparseable', why: 'its "paths" are inherited through "extends" and have no "@/*"; an own "paths" would replace them' }
  return resolveAlias('@/x', ts.base, [hit])?.[0] === 'x' ? { kind: 'present' } : { kind: 'other', target: JSON.stringify(hit[1]) }
}

/** The separator before a non-empty object's first member, so the new entry takes the same line and indent. */
function lead(text: string, o: ObjectNode): string {
  const first = o.members[0]
  if (!first) return ' '
  const nl = text.lastIndexOf('\n', first.keyStart)
  const indent = nl > o.open ? text.slice(nl + 1, first.keyStart) : ''
  if (nl > o.open && /^\s*$/.test(indent)) return `\n${indent}`
  const same = text.slice(o.open + 1, first.keyStart)
  return /^\s*$/.test(same) ? same : ' '
}

/** Adds `"@/*": ["./*"]` to `compilerOptions.paths` as a text splice (R41.4): comments and layout are kept. */
export function addAliasPath(text: string): PathEdit {
  let top: ObjectNode
  try {
    top = readObject(text)
  } catch (e) {
    return { kind: 'unparseable', why: (e as Error).message }
  }
  const co = top.members.find((m) => m.key === 'compilerOptions')?.object
  if (!co) return { kind: 'unparseable', why: 'no compilerOptions object' }
  const pathsMember = co.members.find((m) => m.key === 'paths')
  if (!pathsMember) {
    const ws = lead(text, co)
    const body = co.members.length > 0 ? `${ws}"paths": { ${ENTRY} },` : ` "paths": { ${ENTRY} } `
    return { kind: 'added', text: text.slice(0, co.open + 1) + body + text.slice(co.open + 1) }
  }
  const paths = pathsMember.object
  if (!paths) return { kind: 'unparseable', why: 'compilerOptions.paths is not an object' }
  const existing = paths.members.find((m) => m.key === '@/*')
  if (existing) {
    const target = raw(text, existing)
    return target.replace(/\s+/g, '') === '["./*"]' ? { kind: 'present' } : { kind: 'other', target }
  }
  const ws = lead(text, paths)
  const body = paths.members.length > 0 ? `${ws}${ENTRY},` : ` ${ENTRY} `
  return { kind: 'added', text: text.slice(0, paths.open + 1) + body + text.slice(paths.open + 1) }
}

/** The Tailwind entry CSS: `--css`, else the one top-level `*.css` that imports `tailwindcss` (R41.3). */
function tailwindEntry(root: string, css: string | undefined): { css: string } | { error: string } {
  if (css !== undefined) {
    const abs = resolve(root, css)
    const rel = relative(root, abs)
    if (css.startsWith('-') || isAbsolute(css) || rel.startsWith('..') || !existsSync(abs)) {
      return { error: `--css ${JSON.stringify(css)} must be an existing CSS file inside the project` }
    }
    return { css: rel.split('\\').join('/') }
  }
  const hit = ['app.css', 'styles.css', 'global.css', 'globals.css', 'index.css'].filter((f) => {
    const p = join(root, f)
    return existsSync(p) && /@import\s+["']tailwindcss["']/.test(readFileSync(p, 'utf8'))
  })
  if (hit.length === 1) return { css: hit[0]! }
  return { error: hit.length === 0 ? 'cannot tell which CSS file is the Tailwind entry; pass --css <file>' : `more than one Tailwind entry (${hit.join(', ')}); pass --css <file>` }
}

type Step = 'done' | 'skipped' | 'failed'

/** Returns the process exit code: 0 ok, 2 usage / not a brust project, else the failing child's code. */
export async function shadcnInit(o: InitOptions): Promise<number> {
  const { root, out } = o
  const fail2 = (msg: string): number => {
    out(`error shadcn-init ${msg}`)
    return 2
  }
  // R41.1: a brust project root.
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return fail2('no package.json here: run it in the root of a brust project')
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return fail2('package.json is not valid JSON')
  }
  if (!pkg.dependencies?.['@brust/core'] && !pkg.devDependencies?.['@brust/core']) {
    return fail2('package.json does not depend on @brust/core: run it in the root of a brust project')
  }
  // R41.8: validate everything that reaches an argv before anything is written.
  for (const c of o.components) {
    if (!COMPONENT.test(c) && !REGISTRY_URL.test(c)) return fail2(`component ${JSON.stringify(c)} must match ^[a-z0-9][a-z0-9-]*$ or be an https:// registry URL`)
  }
  const version = o.shadcnVersion ?? SHADCN_VERSION
  if (!VERSION.test(version)) return fail2(`--shadcn-version ${JSON.stringify(version)} must be an exact version like ${SHADCN_VERSION}`)
  const baseColor = o.baseColor ?? 'neutral'
  if (!COLOR.test(baseColor)) return fail2(`--base-color ${JSON.stringify(baseColor)} must be a lowercase colour name`)
  const entry = tailwindEntry(root, o.css)
  if ('error' in entry) return fail2(entry.error)
  // F181: never write through a symlink (the target may be outside the project, e.g. a shared tsconfig). Fail-safe:
  // refuse before the first write, even with --force; the reader edits the real file by hand.
  const cj = join(root, 'components.json')
  const tsPath = join(root, 'tsconfig.json')
  // F192: a symlinked tsconfig.json is only a problem when the command would edit it (the `@/*` path is missing).
  // F226: the `paths` the CLI will see are the ones of the whole `extends` chain; a chain that cannot be read is refused.
  const ts = existsSync(tsPath) ? tsconfigPaths(root, tsPath) : undefined
  if (ts && 'error' in ts) return fail2(`${ts.error}; fix the tsconfig.json chain, then run again`)
  const tsEdit = existsSync(tsPath) ? (ts?.inherited ? inheritedEdit(ts) : addAliasPath(readFileSync(tsPath, 'utf8'))) : undefined
  if (isLink(tsPath) && tsEdit?.kind === 'added') return fail2('tsconfig.json is a symbolic link; refusing to write through it. Add "@/*": ["./*"] to compilerOptions.paths of the real file yourself, then run again')
  if (isLink(cj) && (!existsSync(cj) || o.force)) return fail2('components.json is a symbolic link; refusing to write through it. Replace it with a real file or remove the link, then run again')
  // F193: the shadcn CLI writes files itself (the theme, `lib/utils.ts`, each component, the CSS entry). It follows
  // links, so refuse before spawning it when one of its target paths is, or sits under, a symlink.
  const writing = !existsSync(cj) || o.force
  const themeRuns = o.force || !readFileSync(join(root, entry.css), 'utf8').includes('shadcn/tailwind.css')
  const targets = cliTargets(
    writing ? undefined : readFileSync(cj, 'utf8'),
    ts,
    themeRuns ? entry.css : undefined,
    o.components,
  )
  if ('error' in targets) return fail2(targets.error)
  const hit = cliLink(root, targets)
  if (hit && 'link' in hit) return fail2(`${hit.link} is, or is inside, a symbolic link; the shadcn CLI would write through it. Replace the link with a real directory or file, then run again`)
  if (hit) return fail2(`${hit.tooMany} holds more than ${SCAN_LIMIT} entries, so it cannot be checked for symbolic links before the shadcn CLI writes into it; point the alias at a smaller directory, then run again`)

  // A component whose file is already in components/ui is not added again (idempotent). A registry URL is judged by
  // the item name in its path (`.../acme-card.json` → `acme-card`), looked up in components/ui and components.
  const present = (c: string): boolean => {
    const name = REGISTRY_URL.test(c) ? urlItemName(c) : c
    if (name === undefined) return false
    return existsSync(join(root, 'components/ui', `${name}.tsx`)) || (name !== c && existsSync(join(root, 'components', `${name}.tsx`)))
  }
  const todo = o.components.filter((c) => o.force || !present(c))

  // F228: a registry URL item declares its own file targets, known only once it is fetched. Fetch it now, before the CLI
  // runs, and refuse when a target is outside the project or is, or sits under, a symlink. The CLI is then given the file
  // checked here (not the URL), so the item cannot change between the check and the write.
  const fetchItem = o.fetchItem ?? ((url: string) => fetchRegistryItem(url))
  const vetted = new Map<string, string>()
  for (const c of todo) {
    if (!REGISTRY_URL.test(c) || vetted.has(c)) continue
    let text: string
    try {
      text = await fetchItem(c)
    } catch (e) {
      return fail2(`registry item ${c} was not fetched (${(e as Error).message}), so its file targets cannot be checked; nothing was added`)
    }
    const v = vetItem(text, entry.css)
    if ('error' in v) return fail2(`registry item ${c} ${v.error}; nothing was added`)
    const bad = v.paths.find((p) => linkUnder(root, p))
    if (bad !== undefined) return fail2(`registry item ${c} would write ${bad}, which is, or is inside, a symbolic link; the shadcn CLI would write through it. Replace the link with a real file or directory, then run again`)
    vetted.set(c, text)
  }

  const report = (name: string, step: Step, why = ''): void => out(`${step === 'done' ? '✓' : step === 'skipped' ? '-' : '✗'} ${name}: ${step}${why ? ` (${why})` : ''}`)
  const stop = (name: string, code: number): number => {
    report(name, 'failed', `exit ${code}`)
    out(`error shadcn-init ${name} failed with exit code ${code}; fix it and run the command again (finished steps are skipped)`)
    return code
  }

  // R41.2: components.json.
  if (!existsSync(cj) || o.force) {
    writeFileSync(cj, componentsJson(entry.css, baseColor))
    report('components.json', 'done', entry.css)
  } else report('components.json', 'skipped', 'exists; --force replaces it')

  // R41.4: the `@/*` path.
  if (!existsSync(tsPath)) {
    report('tsconfig.json', 'skipped', `no tsconfig.json; add ${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } })}`)
  } else {
    const edit = tsEdit!
    if (edit.kind === 'added') {
      writeFileSync(tsPath, edit.text)
      report('tsconfig.json', 'done', 'added "@/*": ["./*"] under compilerOptions.paths')
    } else if (edit.kind === 'present') report('tsconfig.json', 'skipped', '"@/*" is already there')
    else if (edit.kind === 'other') report('tsconfig.json', 'skipped', `warning: "@/*" already points at ${edit.target}; shadcn's imports need ["./*"]`)
    else report('tsconfig.json', 'skipped', `not edited (${edit.why}); add this line to compilerOptions.paths yourself: ${ENTRY}`)
  }

  // R41.5: dependencies.
  const have = { ...pkg.devDependencies, ...pkg.dependencies }
  const missing = SHADCN_DEPS.filter((d) => !have[d])
  if (missing.length === 0) report('dependencies', 'skipped', 'all four are installed')
  else {
    const specs = missing.map((d) => `${d}@${SHADCN_DEP_PINS[d]}`)
    const code = await o.run(['bun', 'add', ...specs], root)
    if (code !== 0) return stop('bun add', code)
    report('dependencies', 'done', specs.join(' '))
  }

  // R41.6 / R41.7: the pinned shadcn CLI. `bun x` is `bunx`; argv only.
  const shadcn = (...args: string[]): string[] => ['bun', 'x', `shadcn@${version}`, ...args]
  const cssText = readFileSync(join(root, entry.css), 'utf8')
  if (cssText.includes('shadcn/tailwind.css') && !o.force) report('theme', 'skipped', `${entry.css} already has the shadcn theme; --force runs it again`)
  else {
    const code = await o.run(shadcn('add', 'index', '-y'), root)
    if (code !== 0) return stop('shadcn add index', code)
    report('theme', 'done', `shadcn@${version} add index`)
  }
  for (const c of o.components) if (!todo.includes(c)) report(c, 'skipped', REGISTRY_URL.test(c) ? 'its item is already in components; --force adds it again' : 'components/ui already has it')
  for (const c of todo) if (REGISTRY_URL.test(c)) out(`warning shadcn-init ${c} is third-party code: it is written into your project and runs in your build and in the browser. Read it before you ship`)
  if (todo.length > 0) {
    // a URL item is added from the copy that was checked above
    const dir = vetted.size > 0 ? mkdtempSync(join(tmpdir(), 'brust-shadcn-item-')) : undefined
    try {
      const args = todo.map((c, i) => {
        const text = vetted.get(c)
        if (text === undefined || dir === undefined) return c
        const file = join(dir, `${urlItemName(c) ?? 'item'}-${i}.json`)
        writeFileSync(file, text)
        return file
      })
      const code = await o.run(shadcn('add', ...args, '-y'), root)
      if (code !== 0) return stop(`shadcn add ${todo.join(' ')}`, code)
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
    for (const c of todo) report(c, 'done')
  }

  out('')
  out('next:')
  out("  import the components from './components/ui/<name>' in a page and add the route to routes.tsx")
  out('  bun run build')
  return 0
}

/** The real runner: argv spawn with the terminal attached, no shell. */
export const spawnRunner: Runner = async (argv, cwd) => {
  const p = Bun.spawn(argv, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return await p.exited
}
