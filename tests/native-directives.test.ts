import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildDirectives, directiveName, scanDirectiveComponents } from '../runtime/native/build.ts'

// Temp dirs MUST live under the repo so Bun.build can self-resolve brustjs/* (see the
// note in runtime/native/build.test.ts). `.brust/` is gitignored.
const TMP_BASE = resolve(import.meta.dir, '../.brust/native-int-test')
const dirs: string[] = []
function tmp(): string {
  mkdirSync(TMP_BASE, { recursive: true })
  const d = mkdtempSync(join(TMP_BASE, 'd-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('directive component is discovered and bundled into a react-free _directives.js', async () => {
  const root = tmp()
  mkdirSync(join(root, 'components'))
  writeFileSync(
    join(root, 'routes.tsx'),
    `import Counter from './components/Counter'\nexport const routes = []\n`,
  )
  writeFileSync(
    join(root, 'components/Counter.tsx'),
    `import { signal } from 'brustjs/store'\n` +
      `export const behavior = () => { const n = signal(0); return { n, inc(){ n.set(n()+1) } } }\n` +
      `export default function Counter(){ return null as any }\n`,
  )
  const components = scanDirectiveComponents(join(root, 'routes.tsx'))
  // Path-hashed name (T1): camelCase(basename) + "_" + 8 hex of sha256(rel path).
  // This is the SINGLE name contract — the compiler-injected x-data, the registry
  // key, and the chunk filename all derive from it.
  const counterName = directiveName(join(root, 'components/Counter.tsx'), process.cwd())
  expect(counterName).toMatch(/^counter_[0-9a-f]{8}$/)
  expect([...components.keys()]).toEqual([counterName])
  const outDir = join(root, 'islands')
  const res = await buildDirectives(components, { outDir })
  expect(res.count).toBe(1)
  // Runtime + a per-component chunk; the behavior lives in the chunk, not the runtime.
  // The chunk filename MUST equal `<name>.directive.js` (the F4 name contract: the
  // compiler-injected `x-data="<name>"` fetches exactly this chunk at runtime).
  expect(res.files).toEqual(['_directives.js', `${counterName}.directive.js`])
  expect(existsSync(join(outDir, '_directives.js'))).toBe(true)
  const runtime = readFileSync(join(outDir, '_directives.js'), 'utf8')
  expect(/createRoot|hydrateRoot|react-dom/.test(runtime)).toBe(false)
  const chunk = readFileSync(join(outDir, `${counterName}.directive.js`), 'utf8')
  expect(chunk).toContain(counterName)
  expect(/createRoot|hydrateRoot|react-dom/.test(chunk)).toBe(false)
})

test('bake helper: template with x-data gets the directives <script>, without does not', async () => {
  const { bakeDirectivesIfUsed } = await import('../runtime/cli/native-routes-emit.ts')
  const { DIRECTIVES_BOOTSTRAP } = await import('../runtime/islands/importmap.ts')
  const withDir = bakeDirectivesIfUsed(
    '<body><button x-data="counter" x-on-click="inc">0</button></body>',
  )
  expect(withDir).toContain(DIRECTIVES_BOOTSTRAP)
  const noDir = '<body><div>static</div></body>'
  expect(bakeDirectivesIfUsed(noDir)).toBe(noDir)
})
