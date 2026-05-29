import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { scanCssImports } from './scan-imports.ts'

describe('scanCssImports', () => {
  test('finds plain .css side-effect import', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'scan-imp-'))
    await writeFile(
      path.join(dir, 'Foo.tsx'),
      `import './foo.css'\nexport default function Foo() { return <div /> }\n`,
    )
    await writeFile(path.join(dir, 'foo.css'), '.x { color: red }\n')
    const result = await scanCssImports(dir)
    const foo = result.get(path.join(dir, 'Foo.tsx'))
    expect(foo).toBeDefined()
    expect(foo!.length).toBe(1)
    expect(foo![0].path).toBe(path.join(dir, 'foo.css'))
    expect(foo![0].isModule).toBe(false)
    expect(foo![0].importedName).toBeNull()
  })

  test('finds default-import .module.css', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'scan-imp-'))
    await writeFile(
      path.join(dir, 'Bar.tsx'),
      `import styles from './bar.module.css'\nexport default function Bar() { return <div className={styles.primary} /> }\n`,
    )
    await writeFile(path.join(dir, 'bar.module.css'), '.primary { color: blue }\n')
    const result = await scanCssImports(dir)
    const bar = result.get(path.join(dir, 'Bar.tsx'))
    expect(bar).toBeDefined()
    expect(bar![0].isModule).toBe(true)
    expect(bar![0].importedName).toBe('styles')
  })

  test('skips files outside scanRoot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'scan-imp-'))
    await writeFile(path.join(dir, 'README.md'), 'not code')
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.tsx'), `import './nope.css'\n`)
    const result = await scanCssImports(dir)
    expect(result.size).toBe(0)
  })

  test('handles a file with both .css and .module.css imports', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'scan-imp-'))
    await writeFile(
      path.join(dir, 'Mixed.tsx'),
      `import './global.css'\nimport styles from './mod.module.css'\nexport default function Mixed() { return null }\n`,
    )
    await writeFile(path.join(dir, 'global.css'), '')
    await writeFile(path.join(dir, 'mod.module.css'), '')
    const result = await scanCssImports(dir)
    const deps = result.get(path.join(dir, 'Mixed.tsx'))!
    expect(deps.length).toBe(2)
    expect(deps.find((d) => d.path.endsWith('global.css'))!.isModule).toBe(false)
    expect(deps.find((d) => d.path.endsWith('mod.module.css'))!.isModule).toBe(true)
  })
})
