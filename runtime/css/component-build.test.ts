import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildComponentCss } from './component-build.ts'

describe('buildComponentCss', () => {
  test('emits chunks + manifest + .d.ts for a tmp project', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'compcss-'))
    await writeFile(
      path.join(dir, 'Home.tsx'),
      `import './globals.css'
import styles from './Button.module.css'
export default function Home() { return <button className={styles.primary}>x</button> }
`,
    )
    await writeFile(path.join(dir, 'globals.css'), '.banner { color: red }\n')
    await writeFile(
      path.join(dir, 'Button.module.css'),
      '.primary { color: blue }\n.secondary { color: green }\n',
    )

    const outDir = path.join(dir, 'out')
    const routes = [{ fullPath: '/', componentSource: path.join(dir, 'Home.tsx') }]
    const manifest = await buildComponentCss({
      scanRoot: dir,
      outDir,
      tailwindCompile: null,
      routes,
    })

    // 1. Two CSS chunks emitted
    expect(Object.keys(manifest.modules).length).toBe(2)
    for (const m of Object.values(manifest.modules)) {
      expect(m.chunk).toMatch(/^\/_brust\/css\/components\/[a-f0-9]+\.css$/)
      const rel = m.chunk.replace('/_brust/css/', '')
      expect(existsSync(path.join(outDir, rel))).toBe(true)
    }

    // 2. Module exports for Button
    const btn = manifest.modules[path.join(dir, 'Button.module.css')]
    expect(btn.exports!.primary).toMatch(/^primary_/)
    expect(btn.exports!.secondary).toMatch(/^secondary_/)

    // 3. Non-module .css → exports null
    const glb = manifest.modules[path.join(dir, 'globals.css')]
    expect(glb.exports).toBeNull()

    // 4. routeChunks populated, sorted, deduplicated
    expect(manifest.routeChunks['/']?.length).toBe(2)

    // 5. .d.ts generated next to .module.css
    const dts = await readFile(path.join(dir, 'Button.module.css.d.ts'), 'utf-8')
    expect(dts).toContain('readonly primary')
    expect(dts).toContain('readonly secondary')

    // 6. component-manifest.json written
    const mf = await readFile(path.join(outDir, 'css', 'component-manifest.json'), 'utf-8')
    expect(JSON.parse(mf).version).toBe(1)
  })

  test('skips with empty manifest when no CSS imports exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'compcss-empty-'))
    await writeFile(path.join(dir, 'Home.tsx'), `export default function Home() { return null }\n`)
    const outDir = path.join(dir, 'out')
    const manifest = await buildComponentCss({
      scanRoot: dir,
      outDir,
      tailwindCompile: null,
      routes: [{ fullPath: '/', componentSource: path.join(dir, 'Home.tsx') }],
    })
    expect(Object.keys(manifest.modules).length).toBe(0)
    expect(Object.keys(manifest.routeChunks).length).toBe(1)
    expect(manifest.routeChunks['/']).toEqual([])
  })
})
