// F161 (R39.1): a props pattern that used to compile to a component that fails every render (a quoted key) or to one
// that silently lost its default now falls back to React. Built, and the SSR job's HTML equals React's own render.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { runBuild } from '../src/build'

const app = join(import.meta.dir, 'fixtures/props-pattern')
const dist = join(app, 'dist')

afterAll(() => rmSync(dist, { recursive: true, force: true }))

const CASES: [string, Record<string, unknown>[], 'react' | 'static'][] = [
  ['quoted', [{ 'data-x': '1', id: 'a' }, {}], 'react'],
  ['iife', [{ a: 'z' }, {}], 'react'],
  ['call', [{}, { a: 'q' }], 'react'],
  // F153b part 4 folds a module-constant default (`a = D`) to its literal: the template prints it, so it stays static.
  ['const', [{}, { a: 'q' }], 'static'],
  ['earlier', [{}, { a: 'q' }], 'react'],
  ['jsx', [{}], 'react'],
  ['ok', [{ b: 'B' }, { a: 'Q', n: 5 }], 'static'],
]

const { renderToString } = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }

test('each shape builds; the components that fall back render exactly like React', async () => {
  const logs: string[] = []
  await runBuild({ appRoot: app, entry: 'routes.tsx', outDir: dist, log: (m: string) => logs.push(m), force: true })
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const jobs = (await import(join(dist, 'jobs.js'))).default as Record<string, { ssr?: (p: unknown) => string }>
  const log = logs.join('\n')
  expect(log).toContain('prop-quoted-key')
  expect(log).toContain('prop-default-iife')
  expect((log.match(/prop-default-shape/g) ?? []).length).toBe(3)
  // The component of each cards/<name>.tsx: its SSR job against React's render of the original source.
  for (const [name, propSets, tier] of CASES) {
    const ids = Object.entries<{ tier: string }>(manifest.components)
      .filter(([id, c]) => c.tier === tier && id.startsWith(`${name}_`))
      .map(([id]) => id)
    expect(ids.length, `${name}: ${tier} components`).toBeGreaterThan(0)
    if (tier !== 'react') continue
    const Original = (await import(join(app, 'cards', `${name}.tsx`))).default
    const ssr = jobs[ids[0]!]!.ssr!
    for (const props of propSets) expect(ssr(props), `${name} ${JSON.stringify(props)}`).toBe(renderToString(createElement(Original, props)))
  }
})
