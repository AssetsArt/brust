// Library-level survey (R34.8): the compiler is run over the component modules of every package the fixture imports,
// as if they were app code. The modules are the package's ORIGINAL sources when its source maps carry them
// (`sourcesContent`), else the published ESM (which holds `jsx()` calls, not JSX). Nothing here changes the product:
// `compileTree` is called on a scratch copy, one probe per exported component.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { compileTree } from '../../packages/brust/native/index.js'
import { FIXTURE } from './paths.ts'

/** What each construct costs the compiler today (docs/react-coverage.md: hook table c-*, b-*, d-* rows). */
export const CONSTRUCTS: { name: string; re: RegExp; blocks: boolean; why: string }[] = [
  { name: 'forwardRef', re: /\bforwardRef\b/, blocks: true, why: 'b-forwardref: fallback:default-export-shape' },
  { name: 'createContext', re: /\bcreateContext(?:Scope)?\b/, blocks: true, why: 'd-createcontext: fallback:member-tag' },
  { name: 'useContext / use*Context', re: /\buse(?:[A-Z]\w*)?Context\b/, blocks: true, why: 'c-usecontext: fallback:hook-unsupported' },
  { name: 'Context.Provider / *Provider', re: /\.Provider\b|\b[A-Z]\w*Provider\b/, blocks: true, why: 'fallback:member-tag' },
  { name: 'useReducer', re: /\buseReducer\b/, blocks: true, why: 'c-usereducer: fallback:hook-unsupported' },
  { name: 'useSyncExternalStore', re: /\buseSyncExternalStore\b/, blocks: true, why: 'c-usesyncexternalstore: fallback:hook-unsupported' },
  { name: 'useImperativeHandle', re: /\buseImperativeHandle\b/, blocks: true, why: 'c-useimperativehandle: fallback:hook-unsupported' },
  { name: 'useTransition / useDeferredValue', re: /\buse(?:Transition|DeferredValue)\b|\bstartTransition\b/, blocks: true, why: 'fallback:hook-unsupported' },
  { name: 'createPortal / Portal', re: /\bcreatePortal\b|\bPortal\b/, blocks: true, why: 'd-createportal: fallback:browser-global' },
  { name: 'React.Children', re: /\bChildren\.(?:map|only|toArray|count|forEach)\b/, blocks: true, why: 'd-children-map: fallback:jsx-expression' },
  { name: 'cloneElement', re: /\bcloneElement\b/, blocks: true, why: 'd-clone-element: fallback:hook-unsupported' },
  { name: 'isValidElement', re: /\bisValidElement\b/, blocks: true, why: 'no battery row: not analysable' },
  { name: 'composeRefs', re: /\b(?:composeRefs|useComposedRefs)\b/, blocks: true, why: 'ref shapes other than ref={x}: fallback:ref-shape' },
  { name: 'Slot / asChild', re: /\b(?:Slot|createSlot|Slottable)\b|\basChild\b/, blocks: true, why: 'no battery row: cloneElement-based' },
  { name: 'Primitive.*', re: /\bPrimitive\b/, blocks: true, why: 'fallback:member-tag' },
  { name: 'Presence', re: /\bPresence\b/, blocks: true, why: 'external component' },
  { name: 'useControllableState', re: /\buseControllableState\b/, blocks: false, why: 'custom hook (L5 inlines hooks that use supported hooks)' },
  { name: 'rest-props spread', re: /\.\.\.\s*(?:rest|props|\w+Props|\w+Rest)\b/, blocks: true, why: 'b-spread-child / a-spread-host: fallback:spread-props' },
  { name: 'useLayoutEffect', re: /\buseLayoutEffect\b/, blocks: false, why: 'c-uselayouteffect: native' },
  { name: 'useEffect', re: /\buseEffect\b/, blocks: false, why: 'c-useeffect-*: native' },
  { name: 'useState', re: /\buseState\b/, blocks: false, why: 'c-usestate: native' },
  { name: 'useRef', re: /\buseRef\b/, blocks: false, why: 'c-useref: native' },
  { name: 'useMemo / useCallback', re: /\buse(?:Memo|Callback)\b/, blocks: false, why: 'c-usememo / c-usecallback: native' },
  { name: 'useId', re: /\buseId\b/, blocks: false, why: 'c-useid: static' },
  { name: 'DOM globals (document / window)', re: /\b(?:document|window)\./, blocks: true, why: 'fallback:browser-global in render' },
  { name: 'addEventListener', re: /\baddEventListener\b/, blocks: false, why: 'inside effects: native' },
]

/** Capitalised top-level declarations whose body builds elements are the package's components. */
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/
const ELEMENT = /\b_?jsx\w*\(|\bcreateElement\(/

export type Tier = 'static' | 'native' | 'react'
export interface LibComponent {
  module: string
  name: string
  kind: 'forwardRef' | 'memo' | 'function' | 'other'
  constructs: string[]
  /** exported from its module, so a probe could import it */
  exported: boolean
  /** what the compiler made of it */
  result: { tier: Tier; codes: string[] } | { tier: 'unresolved'; codes: string[] } | { tier: 'error'; codes: string[] } | { tier: 'internal'; codes: string[] }
}
export interface LibPackage {
  name: string
  version: string
  origin: 'source maps' | 'published ESM' | 'barrel (re-exports only)' | 'no components'
  modules: number
  components: LibComponent[]
  /** constructs found anywhere in the package's modules (the only view of minified code, whose component names are mangled) */
  constructs: string[]
  note: string
}

const slug = (s: string) => s.replace(/[^\w]+/g, '_')
const lcfirst = (s: string) => s[0]!.toLowerCase() + s.slice(1)

/** Walk up from `from` to the first `node_modules/<name>/package.json`. */
function findPackage(name: string, from: string): string | null {
  let dir = from
  for (;;) {
    const p = join(dir, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return realpathSync(p)
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const bareImports = (dirs: string[]): string[] => {
  const found = new Set<string>()
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => join(d, f)))
  for (const f of files)
    for (const m of readFileSync(f, 'utf8').matchAll(/from\s+"([^"./][^"]*)"/g)) {
      const spec = m[1]!
      const parts = spec.split('/')
      found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!)
    }
  return [...found].sort()
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = join(dir, e.name)
    e.isDirectory() ? walk(p, out) : out.push(p)
  }
  return out
}

/** Original component sources from the package's source maps; empty when it publishes none. */
function sourcesFromMaps(pkgDir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of walk(pkgDir).filter((f) => f.endsWith('.map')).sort()) {
    let j: { sources?: string[]; sourcesContent?: (string | null)[] }
    try { j = JSON.parse(readFileSync(m, 'utf8')) } catch { continue }
    j.sources?.forEach((s, i) => {
      const c = j.sourcesContent?.[i]
      if (!c || !/\.[jt]sx$/.test(s) || /(^|\/)(__tests__|test|tests|stories)\//.test(s) || /\.(test|spec|stories)\./.test(s)) return
      const rel = posix.normalize(s.replace(/^(\.\.\/)+/, '').replace(/^\/+/, ''))
      if (!out.has(rel)) out.set(rel, c)
    })
  }
  return out
}

/** The published ESM entry plus the relative modules it re-exports (bounded); `scope` narrows a huge package to the part the fixture uses. */
function publishedModules(pkgDir: string, scope?: RegExp): Map<string, string> {
  const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const dot = pj.exports?.['.']
  const pick = (x: unknown): string | null => (typeof x === 'string' ? x : x && typeof x === 'object' ? pick((x as Record<string, unknown>).import ?? (x as Record<string, unknown>).default ?? (x as Record<string, unknown>).module) : null)
  const entryRel = pj.module ?? pick(dot) ?? pj.main
  const out = new Map<string, string>()
  if (typeof entryRel !== 'string') return out
  const queue = [posix.normalize(entryRel.replace(/^\.\//, ''))]
  const seen = new Set<string>()
  while (queue.length && seen.size < 600) {
    const rel = queue.shift()!
    if (seen.has(rel)) continue
    seen.add(rel)
    const file = [rel, `${rel}.js`, `${rel}.mjs`, posix.join(rel, 'index.js'), posix.join(rel, 'index.mjs')].map((r) => join(pkgDir, r)).find((p) => existsSync(p) && !readdirOrNull(p))
    if (!file) continue
    const text = readFileSync(file, 'utf8')
    const relOfFile = file.slice(pkgDir.length + 1).split('\\').join('/')
    if (!scope || scope.test(relOfFile) || out.size === 0) out.set(relOfFile, text)
    for (const m of text.matchAll(/(?:export|import)\s*(?:[^'"]*?from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(posix.normalize(posix.join(posix.dirname(relOfFile), m[1]!)))
  }
  return out
}
const readdirOrNull = (p: string) => { try { readdirSync(p); return true } catch { return false } }

/** Declarations in a module, as transpiled JS (types and JSX lowered, so source and published code look alike). */
function declarations(src: string, file: string): { name: string; span: string }[] {
  let js = src
  if (/\.[jt]sx$/.test(file)) js = new Bun.Transpiler({ loader: file.endsWith('x') && file.endsWith('.jsx') ? 'jsx' : 'tsx' }).transformSync(src)
  const lines = js.split('\n')
  const starts: { name: string; at: number }[] = []
  lines.forEach((l, i) => { const m = DECL.exec(l); if (m) starts.push({ name: m[1]!, at: i }) })
  return starts.map((s, k) => ({ name: s.name, span: lines.slice(s.at, k + 1 < starts.length ? starts[k + 1]!.at : lines.length).join('\n') }))
}

const exportedNames = (src: string): Set<string> => {
  const out = new Set<string>()
  for (const m of src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!)
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g))
    for (const part of m[1]!.split(',')) {
      const [local, alias] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/)
      if (local && !/^type\b/.test(part.trim())) out.add(local)
      void alias
    }
  return out
}

function probe(root: string, module: string, name: string, declared = name): LibComponent['result'] {
  const dir = posix.dirname(module)
  const stem = './' + posix.basename(module).replace(/\.[jt]sx$/, (m) => m)
  const probeFile = posix.join(dir, `__probe_${slug(name)}.tsx`)
  writeFileSync(join(root, probeFile), `import { ${name} } from '${stem.replace(/\.(tsx|jsx)$/, '')}'\nexport default function Probe() {\n  return (\n    <${name} />\n  )\n}\n`)
  try {
    const tree = compileTree(probeFile, root, '/_brust/runtime.js', [])
    if (tree.error) { if (process.env.SHADCN_DEBUG) console.error(module, name, tree.error.message); return { tier: 'error', codes: [`error:${tree.error.rule}${tree.error.rule === 'unresolved-import' && !/\.[jt]sx$/.test(module) ? ' (published .js/.mjs module is not followed)' : ''}`] } }
    const wants = new Set([lcfirst(name), lcfirst(declared)])
    const hit = tree.components.find((c) => wants.has(c.id.replace(/_[0-9a-f]{8}$/, '')))
    if (!hit) {
      const root0 = tree.components[0]
      return { tier: 'unresolved', codes: [...new Set((root0?.diagnostics ?? []).filter((d) => d.class === 'fallback').map((d) => d.rule))].sort().map((r) => `fallback:${r}`) }
    }
    const ir = JSON.parse(hit.ir) as { tier: unknown }
    const tier: Tier = ir.tier === 'Static' ? 'static' : ir.tier === 'Native' ? 'native' : 'react'
    return { tier, codes: [...new Set(hit.diagnostics.filter((d) => d.class === 'fallback').map((d) => d.rule))].sort().map((r) => `fallback:${r}`) }
  } catch (e) {
    return { tier: 'error', codes: [`error:throw ${String(e instanceof Error ? e.message : e).split('\n')[0]!.slice(0, 60)}`] }
  }
}

const SCOPE: Record<string, RegExp> = { '@base-ui/react': /(^|\/)combobox\// }

export function analysePackage(name: string, from: string): { pkg: LibPackage; dir: string | null } {
  const dir = findPackage(name, from)
  if (!dir) return { pkg: { name, version: '?', origin: 'no components', modules: 0, components: [], constructs: [], note: 'not installed' }, dir }
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version as string
  let files = sourcesFromMaps(dir)
  let origin: LibPackage['origin'] = 'source maps'
  if (files.size === 0) { files = publishedModules(dir, SCOPE[name]); origin = 'published ESM' }
  // Inside the package directory, so its own imports resolve like they do in a real install; removed after.
  const scratch = join(dir, '.shadcn-probe')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  const components: LibComponent[] = []
  try {
    for (const [rel, text] of files) {
      mkdirSync(join(scratch, dirname(rel)), { recursive: true })
      writeFileSync(join(scratch, rel), text)
    }
    for (const [rel, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const exported = exportedNames(text)
      let decls: ReturnType<typeof declarations>
      try { decls = declarations(text, rel) } catch { continue }
      for (const d of decls) {
        if (!/^[A-Z]/.test(d.name) || !ELEMENT.test(d.span)) continue
        const head = d.span.split('\n').slice(0, 3).join(' ')
        const kind: LibComponent['kind'] = /\bforwardRef\b/.test(head) ? 'forwardRef' : /\bmemo\(/.test(head) ? 'memo' : /\bfunction\b|=>/.test(head) ? 'function' : 'other'
        const constructs = CONSTRUCTS.filter((c) => c.re.test(d.span)).map((c) => c.name)
        // `const Root = Dialog` + `export { Root }`: the alias is what a consumer can import.
        const via = exported.has(d.name) ? d.name : [...exported].find((a) => new RegExp(`(?:const|let|var)\\s+${a.replace(/\$/g, '\\$')}\\s*=\\s*${d.name.replace(/\$/g, '\\$')}\\s*[;\\n]`).test(text))
        components.push({ module: rel, name: d.name, kind, constructs, exported: via !== undefined, result: via ? probe(scratch, rel, via, d.name) : { tier: 'internal', codes: [] } })
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const all = [...files.values()].join('\n')
  const constructs = CONSTRUCTS.filter((c) => c.re.test(all)).map((c) => c.name)
  const minified = components.length === 0 && origin === 'published ESM' && ELEMENT.test(all)
  return { pkg: { name, version, origin: components.length || minified ? origin : 'no components', modules: files.size, components, constructs, note: minified ? 'minified published code: component names are mangled, only the whole-package construct census is possible' : '' }, dir }
}

/** Every package the fixture's `components/` and `hooks/` import, with `radix-ui` expanded to the `@radix-ui/*` closure it re-exports. */
export function surveyLibs(): LibPackage[] {
  const direct = bareImports([join(FIXTURE, 'components/ui'), join(FIXTURE, 'hooks')]).filter((p) => p !== 'react' && p !== 'react-dom')
  const out: LibPackage[] = []
  const done = new Set<string>()
  const visit = (name: string, from: string, via?: string) => {
    if (done.has(name)) return
    done.add(name)
    if (name === 'lucide-react') {
      const dir = findPackage(name, from)!
      const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version as string
      const used = new Set<string>()
      for (const f of walk(join(FIXTURE, 'components/ui'))) for (const m of readFileSync(f, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) m[1]!.split(',').forEach((s) => s.trim() && used.add(s.trim()))
      out.push({ name, version, origin: 'no components', modules: 0, components: [], constructs: [], note: `${used.size} icons imported by the fixture (${basename(dir)} builds each with createLucideIcon → forwardRef); the compiler inlines them statically (L23)` })
      return
    }
    const { pkg, dir } = analysePackage(name, from)
    if (via) pkg.note = pkg.note ? `via ${via}; ${pkg.note}` : `via ${via}`
    out.push(pkg)
    if (name === 'radix-ui' && dir) {
      pkg.origin = 'barrel (re-exports only)'
      const deps = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {}).filter((d) => d.startsWith('@radix-ui/')).sort()
      for (const d of deps) visit(d, dir, 'radix-ui')
    } else if (name.startsWith('@radix-ui/') && dir) {
      const deps = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {}).filter((d) => d.startsWith('@radix-ui/')).sort()
      for (const d of deps) visit(d, dir, via)
    }
  }
  for (const p of direct) visit(p, FIXTURE)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
