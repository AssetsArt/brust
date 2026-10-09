// Bundles of `brust build` (plan T6, spec S5 step 3): the client runtime, one chunk per
// native/static component, one react island chunk per react-tier component (shared React split
// out), and the server-side jobs module. Every staged artifact's relative imports resolve against
// its component's SOURCE directory through `sourceDirPlugin`; nothing is copied next to generated
// files. Browser outputs are renamed to `<stem>-<sha256 hex10>.js` so the server serves them
// `immutable` (`pipeline.rs` `is_hashed` wants lowercase hex; Bun's `[hash]` is base36).
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { BunPlugin } from 'bun'
import type { Compiled } from './compile'
import { BuildError } from './errors'

const REACT_EXTERNALS = ['react', 'react/*', 'react-dom', 'react-dom/*']
/** Production React (and the production JSX transform: `react/jsx-runtime`, never `jsxDEV`). */
const PRODUCTION = { 'process.env.NODE_ENV': JSON.stringify('production') }

const matchesExternal = (spec: string, external: string[]) =>
  external.some((p) => (p.endsWith('/*') ? spec.startsWith(p.slice(0, -1)) : spec === p))

/** Resolution for staged artifacts (`importer` = a staged file's absolute or real path, registered
 * in `sourceDirOf`): relative imports mean the component's SOURCE directory; bare imports
 * (`react`, `react-dom/client`, npm packages) resolve from `appRoot`, never from wherever `dist/`
 * sits (an `--out-dir` outside the app has no `node_modules` above it). `external` specifiers are
 * left to Bun so they stay external. */
export function sourceDirPlugin(sourceDirOf: Map<string, string>, appRoot: string, external: string[] = []): BunPlugin {
  return {
    name: 'brust-source-dir',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (a) => {
        const dir = sourceDirOf.get(a.importer)
        return dir === undefined ? undefined : { path: Bun.resolveSync(a.path, dir) }
      })
      b.onResolve({ filter: /^[^./]/ }, (a) => {
        if (!sourceDirOf.has(a.importer) || matchesExternal(a.path, external)) return undefined
        return { path: Bun.resolveSync(a.path, appRoot) }
      })
    },
  }
}

const hex = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10)
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Runs one browser `Bun.build` in memory, renames every output `<stem>-<bunhash>.js` to
 * `<stem>-<hex10>.js` (rewriting cross-chunk imports), writes them into `dist/client/` and returns
 * entry stem → `client/<file>`. */
async function browserBuild(
  dist: string,
  what: string,
  config: Omit<Parameters<typeof Bun.build>[0], 'outdir' | 'target' | 'format' | 'naming'> & { splitting?: boolean },
): Promise<Map<string, string>> {
  const res = await Bun.build({
    ...config,
    target: 'browser',
    format: 'esm',
    minify: true,
    define: PRODUCTION,
    naming: { entry: '[name]-[hash].[ext]', chunk: 'chunk-[hash].[ext]', asset: '[name]-[hash].[ext]' },
  })
  if (!res.success) throw new BuildError('bundle', `${what}: ${res.logs.map(String).join('\n')}`)
  const outs = await Promise.all(res.outputs.map(async (o) => ({ o, name: basename(o.path), text: await o.text() })))
  const rename = new Map<string, string>()
  for (const { name, text } of outs) {
    const m = /^(.*)-[^-]+\.js$/.exec(name)
    if (!m) throw new BuildError('bundle', `${what}: unexpected output ${name}`)
    rename.set(name, `${m[1]}-${hex(text)}.js`)
  }
  const entries = new Map<string, string>()
  for (const { o, name, text } of outs) {
    let body = text
    for (const [from, to] of rename) if (from !== name) body = body.split(from).join(to)
    const file = rename.get(name)!
    write(join(dist, 'client', file), body)
    if (o.kind === 'entry-point') entries.set(/^(.*)-[^-]+\.js$/.exec(name)![1]!, `client/${file}`)
  }
  return entries
}

/** `dist/client/runtime-<hex>.js`: runtime-dom, re-exported (client chunks import `signal`,
 * `defineBehavior`, … from this URL) and mounted on `document.documentElement` (contract 6). */
export async function buildRuntime(dist: string): Promise<string> {
  const entry = join(dist, '.stage', 'runtime.ts')
  write(entry, "export * from '@brust/runtime-dom'\nimport { mount } from '@brust/runtime-dom'\nmount(document.documentElement)\n")
  // Resolved from this package (its dependency), not from wherever `dist/` sits.
  const runtimeDom = Bun.resolveSync('@brust/runtime-dom', import.meta.dir)
  const res = await browserBuild(dist, 'runtime', {
    entrypoints: [entry],
    plugins: [
      {
        name: 'brust-runtime-dom',
        setup(b) {
          b.onResolve({ filter: /^@brust\/runtime-dom$/ }, () => ({ path: runtimeDom }))
        },
      },
    ],
  })
  return res.get('runtime')!
}

/** One chunk per component with client JS (`<id>-<hex>.js`). The runtime import stays the
 * absolute `/_brust/client/runtime-<hex>.js` URL the compiler printed. */
export async function buildClientChunks(
  dist: string,
  compiled: Map<string, Compiled>,
  sourceDirOf: Map<string, string>,
  appRoot: string,
): Promise<Map<string, string>> {
  const entrypoints: string[] = []
  for (const c of compiled.values()) {
    if (c.clientJs === undefined) continue
    const file = join(dist, '.stage', 'client', `${c.id}.js`)
    write(file, c.clientJs)
    stage(sourceDirOf, file, c)
    entrypoints.push(file)
  }
  if (entrypoints.length === 0) return new Map()
  return browserBuild(dist, 'client chunks', { entrypoints, external: ['/_brust/*'], plugins: [sourceDirPlugin(sourceDirOf, appRoot)] })
}

/** Registers a written artifact (by its path and its real path: the importer Bun reports). */
function stage(sourceDirOf: Map<string, string>, file: string, c: Compiled): void {
  sourceDirOf.set(file, dirname(c.file))
  sourceDirOf.set(realpathSync(file), dirname(c.file))
}

const isReact = (c: Compiled) => typeof c.ir.tier === 'object' && c.ir.tier !== null && 'React' in c.ir.tier

/** One island chunk per react-tier component (`react-<id>-<hex>.js`, contract 3), React split
 * into a shared chunk the island chunks import relatively. */
export async function buildReactChunks(
  dist: string,
  compiled: Map<string, Compiled>,
  sourceDirOf: Map<string, string>,
  appRoot: string,
): Promise<Map<string, string>> {
  const entrypoints: string[] = []
  for (const c of compiled.values()) {
    if (!isReact(c)) continue
    const file = join(dist, '.stage', 'react', `react-${c.id}.tsx`)
    write(
      file,
      `import { hydrateRoot } from 'react-dom/client'\nimport { createElement } from 'react'\nimport Comp from ${JSON.stringify(c.file)}\n` +
        `;((globalThis as any).__brustIslands ||= []).push([${JSON.stringify(c.id)}, (host: Element, props: any) => { hydrateRoot(host, createElement(Comp, props)) }])\n` +
        `;(globalThis as any).__brustIslandReady?.()\n`,
    )
    stage(sourceDirOf, file, c)
    entrypoints.push(file)
  }
  if (entrypoints.length === 0) return new Map()
  const out = await browserBuild(dist, 'react islands', { entrypoints, splitting: true, plugins: [sourceDirPlugin(sourceDirOf, appRoot)] })
  return new Map([...out].map(([stem, path]) => [stem.slice('react-'.length), path]))
}

/** `dist/jobs.js` (`target: 'bun'`, React external — one React at runtime): default export
 * `{ [componentId]: { precompute?, ssr? } }`; `ssr` only for react-tier, non-client_only components. */
export async function buildJobs(
  dist: string,
  compiled: Map<string, Compiled>,
  sourceDirOf: Map<string, string>,
  appRoot: string,
): Promise<void> {
  const imports: string[] = ["import { createElement } from 'react'", "import { renderToString } from 'react-dom/server'"]
  const entries: string[] = []
  let n = 0
  for (const c of compiled.values()) {
    const fns: string[] = []
    if (c.serverTs !== undefined) {
      const file = join(dist, 'jobs', `${c.id}.server.ts`)
      write(file, c.serverTs)
      stage(sourceDirOf, file, c)
      imports.push(`import * as j${n} from ${JSON.stringify(file)}`)
      fns.push(`precompute: j${n}.precompute`)
    }
    if (isReact(c) && !c.ir.tier.React.client_only) {
      imports.push(`import C${n} from ${JSON.stringify(c.file)}`)
      fns.push(`ssr: (props: any) => renderToString(createElement(C${n}, props))`)
    }
    if (fns.length > 0) entries.push(`  ${JSON.stringify(c.id)}: { ${fns.join(', ')} },`)
    n++
  }
  const entry = join(dist, '.stage', 'jobs.ts')
  write(entry, `${imports.join('\n')}\nexport default {\n${entries.join('\n')}\n}\n`)
  const res = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    define: PRODUCTION,
    external: REACT_EXTERNALS,
    plugins: [sourceDirPlugin(sourceDirOf, appRoot, REACT_EXTERNALS)],
  })
  if (!res.success) throw new BuildError('bundle', `jobs: ${res.logs.map(String).join('\n')}`)
  write(join(dist, 'jobs.js'), await res.outputs[0]!.text())
}
