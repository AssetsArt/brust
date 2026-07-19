import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateChangedModules } from './validate-change.ts'

test('validateChangedModules accepts valid TS, TSX, JS, and JSX with matching loaders', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brust-validate-change-'))
  try {
    const files = {
      'valid.ts': 'const value: number = 1\nexport { value }\n',
      'valid.tsx': 'export default function Page() { return <main>ok</main> }\n',
      'valid.js': 'export const value = globalThis?.value\n',
      'valid.jsx': 'export default function Page() { return <main>ok</main> }\n',
    }
    const paths = await Promise.all(
      Object.entries(files).map(async ([name, source]) => {
        const file = path.join(root, name)
        await writeFile(file, source)
        return file
      }),
    )

    await expect(validateChangedModules(paths)).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateChangedModules reports every invalid module with a stable filename-bearing error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brust-validate-change-invalid-'))
  try {
    const invalidTs = path.join(root, 'broken.ts')
    const invalidJsx = path.join(root, 'broken.jsx')
    await Promise.all([
      writeFile(invalidTs, 'export const broken = @@@\n'),
      writeFile(invalidJsx, 'export default function Broken() { return <main>\n'),
    ])

    let failure: unknown
    try {
      await validateChangedModules([invalidTs, invalidJsx])
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('Invalid changed module syntax')
    expect(message).toContain(invalidTs)
    expect(message).toContain(invalidJsx)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateChangedModules skips deleted and non-module paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brust-validate-change-skips-'))
  try {
    const css = path.join(root, 'app.css')
    const markdown = path.join(root, 'guide.md')
    const html = path.join(root, 'index.html')
    await Promise.all([
      writeFile(css, '@@@ not JavaScript'),
      writeFile(markdown, '@@@ not JavaScript'),
      writeFile(html, '<main>not JavaScript</main>'),
    ])

    await expect(
      validateChangedModules([path.join(root, 'deleted.ts'), css, markdown, html]),
    ).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
