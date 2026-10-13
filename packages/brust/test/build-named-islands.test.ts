// shadcn S1.1 (R34.11): `brust build` imports a React island by the binding its importer used. The fixture holds every
// export form (`export function`, `export const`, `export { A as B }`, a barrel's `export { X } from`, a default
// re-exported by name) plus a helper component its module does not export; each is an island chunk and an SSR job,
// and `jobs.js` / the island entries import the right binding. Hydration is `tests/server/named-export-islands.chromium.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { componentImport } from '../src/build/bundle'
import type { Compiled } from '../src/build/compile'

const app = join(import.meta.dir, 'fixtures/named-export-islands')
const dist = join(app, 'dist')

afterAll(() => rmSync(dist, { recursive: true, force: true }))

const stub = (ir: Record<string, unknown>) => ({ id: 'x_1', file: '/app/ui.tsx', ir: { tier: { React: {} }, ...ir } }) as unknown as Compiled

test('componentImport follows the binding the importer used', () => {
  expect(componentImport(stub({}), 'C')).toBe('import C from "/app/ui.tsx"')
  expect(componentImport(stub({ export: 'Button' }), 'C')).toBe('import { Button as C } from "/app/ui.tsx"')
  expect(componentImport(stub({ export: 'default' }), 'C')).toBe('import C from "/app/ui.tsx"')
  expect(componentImport(stub({ export: 'a-b' }), 'C')).toBe('import { "a-b" as C } from "/app/ui.tsx"')
  expect(componentImport(stub({ external: { source: 'lucide-react', export: 'Heart' } }), 'C')).toBe('import { Heart as C } from "lucide-react"')
})

test('every export form builds: one island chunk and one SSR job each', async () => {
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: () => {}, force: true })
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const react = Object.entries<{ tier: string }>(manifest.components).filter(([, c]) => c.tier === 'react')
  // `Epsilon` is a default export, so its id comes from the file stem (`delta`); the others from their binding.
  expect(react.map(([id]) => id.replace(/_[0-9a-f]{8}$/, '')).sort()).toEqual(['alpha', 'beta', 'delta', 'delta', 'gam', 'helper'])
  const jobs = readFileSync(join(dist, 'jobs.js'), 'utf8')
  for (const [id] of react) expect(jobs).toContain(`"${id}"`)
  const chunks = readdirSync(join(dist, 'client')).filter((f) => f.startsWith('react-'))
  expect(chunks.length).toBe(react.length)
})
