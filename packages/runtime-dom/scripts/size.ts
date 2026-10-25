// Byte budget of the client runtime (L33, R35.5): gzip size of the core and of each feature module as the browser build
// ships them (minified; the core is mounted, a feature imports the core's API from the shared core file). `bun scripts/size.ts`
// prints the table; `--check` fails when the core or a feature grew past `docs/runtime-budget.json`. To raise a budget, edit
// that file in the PR that grows the runtime and put the reason in its `reason` line: a silent growth is what this stops.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const src = resolve(import.meta.dir, '../src')
export const BUDGET_FILE = resolve(import.meta.dir, '../../../docs/runtime-budget.json')
export const FEATURES = ['basics', 'if', 'for', 'model', 'html', 'island', 'collection', 'store'] as const

export async function bundle(entry: string, coreExternal: boolean): Promise<string> {
  const r = await Bun.build({
    entrypoints: [resolve(src, entry)], minify: true, format: 'esm', target: 'browser', define: { __BRUST_DEV__: 'false' },
    plugins: coreExternal ? [{ name: 'core-external', setup: (b) => { b.onResolve({ filter: /core-api$|\/core$/ }, () => ({ path: './core.js', external: true })) } }] : [],
  })
  if (!r.success) throw new Error(r.logs.map(String).join('\n'))
  return await r.outputs[0]!.text()
}
const gz = (s: string) => gzipSync(s, { level: 9 }).length

export interface Sizes { core: number; features: Record<string, number>; nav: number }
export async function measure(): Promise<Sizes> {
  // The browser entry of the core also mounts the document; the measured core is that plus its API.
  const core = gz((await bundle('core.ts', false)) + 'mount(document.documentElement)')
  const features: Record<string, number> = {}
  for (const f of FEATURES) features[f] = gz(await bundle(`features/${f}.ts`, true))
  // The SPA navigation asset (design 2026-10-25 §5.8): standalone, its own file on every full document.
  const nav = gz(await bundle('nav/index.ts', false))
  return { core, features, nav }
}

export interface Budget { core: number; features: Record<string, number>; nav?: number; reason: string }

if (import.meta.main) {
  const s = await measure()
  const b = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget
  const rows = [['core', s.core, b.core] as const, ...Object.entries(s.features).map(([f, n]) => [f, n, b.features[f] ?? 0] as const), ['nav', s.nav, b.nav ?? 0] as const]
  let bad = 0
  for (const [name, n, max] of rows) {
    const over = n > max
    if (over) bad++
    console.log(`${name.padEnd(8)} ${String(n).padStart(5)} B gzip  budget ${String(max).padStart(5)}${over ? '  OVER' : ''}`)
  }
  if (process.argv.includes('--check') && bad > 0) {
    console.error(`[runtime-size] ${bad} over budget: raise it in docs/runtime-budget.json with a reason in the PR that grows the runtime`)
    process.exit(1)
  }
}
