import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildCss } from './build.ts'

describe('buildCss', () => {
  test('compiles Tailwind v4 and emits utilities used in @source-scanned files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'brust-css-build-'))

    await writeFile(
      path.join(dir, 'app.css'),
      [
        '@import "tailwindcss";',
        '@source "./**/*.tsx";',
        '',
      ].join('\n'),
      'utf-8',
    )

    await writeFile(
      path.join(dir, 'foo.tsx'),
      'export default function Foo() { return <div className="bg-red-500" /> }\n',
      'utf-8',
    )

    const outDir = path.join(dir, 'out')
    const result = await buildCss({ entry: path.join(dir, 'app.css'), outDir })

    expect(result).toEqual({ outDir, files: ['app.css'] })

    const css = await readFile(path.join(outDir, 'app.css'), 'utf-8')
    expect(css).toContain('.bg-red-500')
    expect(css).not.toContain('.bg-blue-999')
    expect(css).not.toContain('@source')
    expect(css).not.toContain('@import "tailwindcss"')
  })

  test('throws when entry file is missing', async () => {
    await expect(
      buildCss({ entry: '/no/such/file.css', outDir: '/tmp/never' }),
    ).rejects.toThrow()
  })
})
