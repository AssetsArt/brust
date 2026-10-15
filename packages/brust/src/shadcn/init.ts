// `brust shadcn init [component ...]`: sets a brust project up for shadcn/ui and adds components (F175, R41.1-R41.10).
// shadcn's own `init` does not detect brust, so this writes what `add` needs (components.json, the `@/*` path),
// installs the four packages the components import, and runs ONE pinned shadcn CLI for the theme and the components.
// Every child process is spawned from an argv array, never through a shell; the runner is injected for tests.
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { type ObjectNode, raw, readObject } from './jsonc'

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

/** Where the shadcn CLI writes, project-relative: the alias directories of `components.json` (`@/x` → `x`; the defaults
 *  when we are writing it or it has none), `lib/utils.ts`, the Tailwind CSS entry (when the theme step runs) and one file per plain component name. */
function cliTargets(componentsText: string | undefined, css: string | undefined, components: string[]): string[] {
  const alias = (k: string, d: string): string => {
    try {
      const a = (JSON.parse(componentsText ?? '{}') as { aliases?: Record<string, unknown> }).aliases?.[k]
      return typeof a === 'string' && a.startsWith('@/') && !a.split('/').includes('..') ? a.slice(2) : d
    } catch {
      return d
    }
  }
  const ui = alias('ui', 'components/ui')
  const lib = alias('lib', 'lib')
  const utils = alias('utils', 'lib/utils')
  return [ui, alias('components', 'components'), lib, `${utils}.ts`, ...(css === undefined ? [] : [css]), ...components.filter((c) => COMPONENT.test(c)).map((c) => `${ui}/${c}.tsx`)]
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
  const tsEdit = existsSync(tsPath) ? addAliasPath(readFileSync(tsPath, 'utf8')) : undefined
  if (isLink(tsPath) && tsEdit?.kind === 'added') return fail2('tsconfig.json is a symbolic link; refusing to write through it. Add "@/*": ["./*"] to compilerOptions.paths of the real file yourself, then run again')
  if (isLink(cj) && (!existsSync(cj) || o.force)) return fail2('components.json is a symbolic link; refusing to write through it. Replace it with a real file or remove the link, then run again')
  // F193: the shadcn CLI writes files itself (the theme, `lib/utils.ts`, each component, the CSS entry). It follows
  // links, so refuse before spawning it when one of its target paths is, or sits under, a symlink.
  const writing = !existsSync(cj) || o.force
  const themeRuns = o.force || !readFileSync(join(root, entry.css), 'utf8').includes('shadcn/tailwind.css')
  const targets = cliTargets(writing ? undefined : readFileSync(cj, 'utf8'), themeRuns ? entry.css : undefined, o.components)
  const hit = targets.find((t) => linkUnder(root, t))
  if (hit !== undefined) return fail2(`${hit} is, or is inside, a symbolic link; the shadcn CLI would write through it. Replace the link with a real directory or file, then run again`)

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
  // A component whose file is already in components/ui is not added again (idempotent). A registry URL is judged by
  // the item name in its path (`.../acme-card.json` → `acme-card`), looked up in components/ui and components.
  const present = (c: string): boolean => {
    const name = REGISTRY_URL.test(c) ? urlItemName(c) : c
    if (name === undefined) return false
    return existsSync(join(root, 'components/ui', `${name}.tsx`)) || (name !== c && existsSync(join(root, 'components', `${name}.tsx`)))
  }
  const todo = o.components.filter((c) => o.force || !present(c))
  for (const c of o.components) if (!todo.includes(c)) report(c, 'skipped', REGISTRY_URL.test(c) ? 'its item is already in components; --force adds it again' : 'components/ui already has it')
  for (const c of todo) if (REGISTRY_URL.test(c)) out(`warning shadcn-init ${c} is third-party code: it is written into your project and runs in your build and in the browser. Read it before you ship`)
  if (todo.length > 0) {
    const code = await o.run(shadcn('add', ...todo, '-y'), root)
    if (code !== 0) return stop(`shadcn add ${todo.join(' ')}`, code)
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
