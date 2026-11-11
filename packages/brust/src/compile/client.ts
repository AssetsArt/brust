// F518 R3.5: the client module of a runtime component. ONE `Bun.build`, no splitting, minified; the runtime URL, the rt-store
// URL and every exposed module stay external at the URLs the build gave them, so the artifact shares the page's runtime, its
// stores and the app's module instances. Anything else a component's client code imports is a `runtime-import`.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { CompiledComponent } from '../../native/index.js'
import { PRODUCTION, runtimeAliasPlugin } from '../build/bundle'
import type { Diagnostic } from './index'
import { exposedByPath, resolveSpec } from './resolve'

interface Ctx {
  base: string
  runtimeUrl: string
  storeUrl: string
  exposed: Record<string, string>
}

const problem = (message: string, remediation: string): Diagnostic => ({ class: 'error', rule: 'runtime-import', message, line: 0, col: 0, remediation })

let scanner: InstanceType<typeof Bun.Transpiler> | undefined

export async function bundleClient(tree: CompiledComponent[], ctx: Ctx, o: { appRoot: string; filename: string }): Promise<{ code: string | null; problems: Diagnostic[] }> {
  const parts = tree.filter((c) => c.clientJs != null)
  if (parts.length === 0) return { code: null, problems: [] }
  const problems: Diagnostic[] = []
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brust-rc-')))
  try {
    mkdirSync(dir, { recursive: true })
    const exposed = exposedByPath(o.appRoot, ctx.exposed)
    // Each staged file resolves its relative imports from the directory of the component it came from (a child inlined from
    // another file imports from there), the way the build's `sourceDirPlugin` does.
    const fromDir = new Map<string, string>()
    const entry = join(dir, 'entry.js')
    const lines: string[] = []
    for (const [i, c] of parts.entries()) {
      const file = join(dir, `c${i}.js`)
      writeFileSync(file, c.clientJs!)
      fromDir.set(file, dirname(resolve(o.appRoot, c.source)))
      lines.push(`import "./c${i}.js"`)
      for (const m of c.clientModules ?? []) writeFileSync(join(dir, `${m.name}.js`), m.code)
    }
    writeFileSync(entry, `${lines.join('\n')}\n`)
    const urls = { core: ctx.runtimeUrl, store: ctx.storeUrl }
    const res = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'esm',
      minify: true,
      splitting: false,
      define: PRODUCTION,
      external: [`${ctx.base}/_brust/*`],
      plugins: [
        runtimeAliasPlugin(urls),
        {
          name: 'brust-runtime-component',
          setup(b) {
            // A specialised clone's factory several components share (R34.124): written beside the staged files.
            b.onResolve({ filter: /^brust-spec:/ }, (a) => ({ path: join(dir, `${a.path.slice('brust-spec:'.length)}.js`) }))
            b.onResolve({ filter: /.*/ }, (a) => {
              if (!a.importer.startsWith(dir) || a.importer === entry || a.path.startsWith(`${ctx.base}/_brust/`)) return undefined
              const from = fromDir.get(a.importer) ?? dirname(resolve(o.appRoot, o.filename))
              const file = resolveSpec(a.path, from, o.appRoot)
              const url = file === undefined ? undefined : exposed.get(file)
              if (url !== undefined) return { path: `${ctx.base}/_brust/${url}`, external: true }
              problems.push(problem(`the client code imports "${a.path}", which is not an exposed module`, 'list the module in brust.toml `[build] expose` and rebuild, or remove the import'))
              return { path: a.path, external: true }
            })
          },
        },
      ],
    })
    if (!res.success) return { code: null, problems: [...problems, problem(`the client module did not bundle: ${res.logs.map(String).join('; ')}`, 'the same code builds in a route component only if its imports resolve; check them')] }
    if (problems.length > 0) return { code: null, problems }
    if (res.outputs.length !== 1) return { code: null, problems: [problem(`the client module bundled into ${res.outputs.length} files; a runtime component is one module`, 'import shared code from an exposed module')] }
    const code = await res.outputs[0]!.text()
    // The chunk may import exactly the three kinds of URL: the runtime, the rt-store module, an exposed module.
    scanner ??= new Bun.Transpiler({ loader: 'js' })
    const allowed = new Set([ctx.runtimeUrl, ctx.storeUrl, ...Object.values(ctx.exposed).map((f) => `${ctx.base}/_brust/${f}`)])
    for (const i of scanner.scanImports(code)) if (!allowed.has(i.path)) problems.push(problem(`the client module imports "${i.path}", which is neither the runtime, the store module nor an exposed module`, 'remove the import'))
    return problems.length > 0 ? { code: null, problems } : { code, problems: [] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
