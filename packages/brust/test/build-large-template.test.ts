// F556: `brust build` warns (never fails) when one emitted template is larger than 1 MB: such a template slows
// `brust start` (each one is parsed when it loads) and holds its memory. An app report had 120 MB templates and the
// build printed nothing.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LARGE_TEMPLATE_BYTES, largeTemplateWarning, runBuild } from '../src/build'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** An app (inside the package, so `@brust/core` resolves) whose page prints `text`. */
const app = (text: string) => {
  const dir = mkdtempSync(join(import.meta.dir, '.tmp-large-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'Page.tsx'), `export default function Page() {\n  return <main><p>${text}</p></main>\n}\n`)
  writeFileSync(
    join(dir, 'routes.tsx'),
    "import { defineRoutes } from '@brust/core/routes'\nimport Page from './Page'\n\nexport const routes = defineRoutes([{ path: '/', Component: Page }])\n",
  )
  return dir
}

const build = async (dir: string) => {
  const logs: string[] = []
  // A build error throws: the warning never fails the build.
  await runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: join(dir, 'dist'), log: (l) => logs.push(l) })
  return logs.filter((l) => l.includes('warning template '))
}

test('a template over 1 MB prints the warning once, and the build succeeds', async () => {
  const dir = app('x'.repeat(LARGE_TEMPLATE_BYTES + 64 * 1024))
  const warnings = await build(dir)
  expect(warnings).toHaveLength(1)
  const w = warnings[0] ?? ''
  expect(w).toMatch(
    /^\[brust\] warning template page_[0-9a-f]+\.jinja is 1\.1 MB \(Page\.tsx\): a large template slows start-up and uses memory; see https:\/\/brust\.dev\/docs\/cli#large-templates$/,
  )
  const id = w.match(/template (\S+) is/)?.[1] ?? ''
  expect(statSync(join(dir, 'dist', 'jinja', id)).size).toBeGreaterThan(LARGE_TEMPLATE_BYTES)
}, 120_000)

test('an ordinary app prints none', async () => {
  expect(await build(app('hello'))).toEqual([])
}, 120_000)

test('the threshold is bytes of the file, strictly above 1 MB', () => {
  const at = (n: number) => largeTemplateWarning({ id: 'c_1', file: '/app/src/C.tsx', jinja: 'a'.repeat(n) }, '/app')
  expect(at(LARGE_TEMPLATE_BYTES)).toBeUndefined()
  expect(at(LARGE_TEMPLATE_BYTES + 1)).toContain('warning template c_1.jinja is 1.0 MB (src/C.tsx)')
  // Multi-byte text counts in bytes (the file), not UTF-16 units.
  expect(largeTemplateWarning({ id: 'c_2', file: '/app/C.tsx', jinja: 'é'.repeat(LARGE_TEMPLATE_BYTES / 2 + 1) }, '/app')).toBeDefined()
})
