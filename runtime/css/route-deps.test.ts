import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { computeRouteChunks } from './route-deps.ts'

describe('computeRouteChunks', () => {
  test('walks one route → finds its CSS deps', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'route-deps-'))
    await writeFile(
      path.join(dir, 'Home.tsx'),
      `import './home.css'\nimport styles from './home.module.css'\nexport default function Home() { return null }\n`,
    )
    await writeFile(path.join(dir, 'home.css'), '')
    await writeFile(path.join(dir, 'home.module.css'), '')

    const scan = new Map([
      [
        path.join(dir, 'Home.tsx'),
        [
          { path: path.join(dir, 'home.css'), isModule: false, importedName: null },
          { path: path.join(dir, 'home.module.css'), isModule: true, importedName: 'styles' },
        ],
      ],
    ])
    const modules: Record<string, { chunk: string }> = {
      [path.join(dir, 'home.css')]: { chunk: '/_brust/css/components/a.css' },
      [path.join(dir, 'home.module.css')]: { chunk: '/_brust/css/components/b.css' },
    }
    const routes = [{ fullPath: '/', componentSource: path.join(dir, 'Home.tsx') }]
    const result = computeRouteChunks(routes, scan, modules)
    expect(result['/']).toEqual(['/_brust/css/components/a.css', '/_brust/css/components/b.css'])
  })

  test('deduplicates shared chunks across nested imports', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'route-deps-'))
    await writeFile(path.join(dir, 'A.tsx'), `import './shared.css'\n`)
    await writeFile(
      path.join(dir, 'B.tsx'),
      `import './shared.css'\nimport './A'\nexport default function B() { return null }\n`,
    )
    await writeFile(path.join(dir, 'shared.css'), '')

    const sharedDep = { path: path.join(dir, 'shared.css'), isModule: false, importedName: null }
    const scan = new Map([
      [path.join(dir, 'A.tsx'), [sharedDep]],
      [path.join(dir, 'B.tsx'), [sharedDep]],
    ])
    const modules: Record<string, { chunk: string }> = {
      [path.join(dir, 'shared.css')]: { chunk: '/_brust/css/components/shared.css' },
    }
    const routes = [{ fullPath: '/', componentSource: path.join(dir, 'B.tsx') }]
    const result = computeRouteChunks(routes, scan, modules)
    expect(result['/']).toEqual(['/_brust/css/components/shared.css'])
  })

  test('output is sorted for deterministic order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'route-deps-'))
    await writeFile(
      path.join(dir, 'X.tsx'),
      `import './z.css'\nimport './a.css'\nimport './m.css'\nexport default function X(){return null}\n`,
    )
    const scan = new Map([
      [
        path.join(dir, 'X.tsx'),
        [
          { path: path.join(dir, 'z.css'), isModule: false, importedName: null },
          { path: path.join(dir, 'a.css'), isModule: false, importedName: null },
          { path: path.join(dir, 'm.css'), isModule: false, importedName: null },
        ],
      ],
    ])
    const modules = {
      [path.join(dir, 'z.css')]: { chunk: '/_brust/css/components/z.css' },
      [path.join(dir, 'a.css')]: { chunk: '/_brust/css/components/a.css' },
      [path.join(dir, 'm.css')]: { chunk: '/_brust/css/components/m.css' },
    }
    const routes = [{ fullPath: '/', componentSource: path.join(dir, 'X.tsx') }]
    const result = computeRouteChunks(routes, scan, modules)
    expect(result['/']).toEqual([
      '/_brust/css/components/a.css',
      '/_brust/css/components/m.css',
      '/_brust/css/components/z.css',
    ])
  })
})
