// F556: `brust build` warns (never fails) when one emitted template is larger than 1 MB: such a template slows
// `brust start` (each one is parsed when it loads) and holds its memory. An app report had 120 MB templates and the
// build printed nothing.
// F570: `[build] template_max_bytes` turns that warning into a build error above a budget the app states.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LARGE_TEMPLATE_BYTES, largeTemplateWarning, runBuild, templateBudgetViolations } from '../src/build'
import { loadBuildConfig, parseTemplateMaxBytes } from '../src/build/config'

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

// ---- F570: [build] template_max_bytes ----

/** An app with one page per entry of `pages` (a route `/<name>` printing `size` bytes of text) and the given `brust.toml`. */
const budgetApp = (pages: Record<string, number>, toml: string | null) => {
  const dir = mkdtempSync(join(import.meta.dir, '.tmp-large-'))
  dirs.push(dir)
  const names = Object.keys(pages)
  for (const n of names) writeFileSync(join(dir, `${n}.tsx`), `export default function ${n}() {\n  return <main><p>${'x'.repeat(pages[n]!)}</p></main>\n}\n`)
  writeFileSync(
    join(dir, 'routes.tsx'),
    `import { defineRoutes } from '@brust/core/routes'\n${names.map((n) => `import ${n} from './${n}'`).join('\n')}\n\nexport const routes = defineRoutes([${names.map((n) => `{ path: '/${n}', Component: ${n} }`).join(', ')}])\n`,
  )
  if (toml !== null) writeFileSync(join(dir, 'brust.toml'), toml)
  return dir
}

const budgetBuild = async (dir: string, dev = false) => {
  const logs: string[] = []
  await runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: join(dir, 'dist'), dev, log: (l) => logs.push(l) })
  return logs
}

test('a budget above the size passes, and the 1 MB warning stays for a template over 1 MB', async () => {
  const small = await budgetBuild(budgetApp({ A: 100 }, '[build]\ntemplate_max_bytes = 100000\n'))
  expect(small.filter((l) => l.includes('warning template'))).toEqual([])
  const big = await budgetBuild(budgetApp({ A: LARGE_TEMPLATE_BYTES + 1000 }, `[build]\ntemplate_max_bytes = ${LARGE_TEMPLATE_BYTES * 2}\n`))
  expect(big.filter((l) => l.includes('warning template '))).toHaveLength(1)
}, 120_000)

test('a budget below the size fails the build with the id, bytes, budget and source, and publishes no dist', async () => {
  const dir = budgetApp({ A: 5000 }, '[build]\ntemplate_max_bytes = 1000\n')
  const err = await budgetBuild(dir).then(
    () => undefined,
    (e: unknown) => e as Error & { rule: string },
  )
  expect(err?.rule).toBe('template-size')
  const lines = err?.message.split('\n') ?? []
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(/^a_[0-9a-f]+\.jinja is \d+ bytes \(0\.0 MB\), over \[build\] template_max_bytes = 1000 \(A\.tsx\)$/)
  expect(lines[1]).toBe('a template grows with what a page inlines; see https://brust.dev/docs/cli#large-templates')
  expect(existsSync(join(dir, 'dist'))).toBe(false)
}, 120_000)

test('a failed build leaves an existing dist as it was', async () => {
  const dir = budgetApp({ A: 5000 }, null)
  await budgetBuild(dir)
  const manifest = join(dir, 'dist', 'manifest.json')
  const before = readFileSync(manifest, 'utf8')
  writeFileSync(join(dir, 'brust.toml'), '[build]\ntemplate_max_bytes = 1000\n')
  await expect(budgetBuild(dir)).rejects.toMatchObject({ rule: 'template-size' })
  expect(readFileSync(manifest, 'utf8')).toBe(before)
  expect(existsSync(join(dir, '.dist.brust-tmp'))).toBe(false)
}, 120_000)

test('every template over the budget is listed in one error, largest first, once each', async () => {
  const dir = budgetApp({ Small: 200, Mid: 4000, Big: 9000 }, '[build]\ntemplate_max_bytes = 2000\n')
  const err = await budgetBuild(dir).then(
    () => undefined,
    (e: unknown) => e as Error & { rule: string },
  )
  const lines = (err?.message ?? '').split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain('(Big.tsx)')
  expect(lines[1]).toContain('(Mid.tsx)')
  expect(err?.message).not.toContain('Small.tsx')
}, 120_000)

test('a template over the 1 MB warning and the budget is reported by the error only', async () => {
  const logs: string[] = []
  const dir = budgetApp({ A: LARGE_TEMPLATE_BYTES + 1000 }, `[build]\ntemplate_max_bytes = ${LARGE_TEMPLATE_BYTES}\n`)
  await runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: join(dir, 'dist'), dev: true, log: (l) => logs.push(l) })
  expect(logs.filter((l) => l.startsWith('[brust] warning template '))).toEqual([])
  expect(logs.filter((l) => l.startsWith('[brust] warning template-size '))).toHaveLength(1)
}, 120_000)

test('in dev the budget is a warning and the build goes on', async () => {
  const dir = budgetApp({ A: 5000 }, '[build]\ntemplate_max_bytes = 1000\n')
  const logs = await budgetBuild(dir, true)
  const w = logs.filter((l) => l.startsWith('[brust] warning template-size '))
  expect(w).toHaveLength(1)
  expect(w[0]).toMatch(/^\[brust\] warning template-size a_[0-9a-f]+\.jinja is \d+ bytes .*over \[build\] template_max_bytes = 1000 \(A\.tsx\)\na template grows/)
  expect(existsSync(join(dir, 'dist', 'manifest.json'))).toBe(true)
}, 120_000)

test('no key and 0 mean no budget', async () => {
  for (const toml of [null, '[build]\ntemplate_max_bytes = 0\n']) {
    const logs = await budgetBuild(budgetApp({ A: 5000 }, toml))
    expect(logs.filter((l) => l.includes('template-size'))).toEqual([])
  }
}, 120_000)

test('template_max_bytes must be a non-negative integer', async () => {
  expect(parseTemplateMaxBytes('brust.toml', undefined)).toBe(0)
  expect(parseTemplateMaxBytes('brust.toml', 0)).toBe(0)
  expect(parseTemplateMaxBytes('brust.toml', 2_000_000)).toBe(2_000_000)
  for (const v of [-1, 1.5, '1000', true, [1]]) expect(() => parseTemplateMaxBytes('brust.toml', v)).toThrow(/build\.template_max_bytes must be a non-negative integer \(bytes\)/)
  const dir = budgetApp({ A: 10 }, '[build]\ntemplate_max_bytes = -5\n')
  await expect(loadBuildConfig(dir)).rejects.toMatchObject({ rule: 'config', message: expect.stringMatching(/build\.template_max_bytes must be a non-negative integer/) })
  expect((await loadBuildConfig(budgetApp({ A: 10 }, '[build]\ntemplate_max_bytes = 123\n'))).templateMaxBytes).toBe(123)
  expect((await loadBuildConfig(budgetApp({ A: 10 }, null))).templateMaxBytes).toBe(0)
})

test('the violations are bytes of the file, strictly above the budget, largest first, none without a budget', () => {
  const t = (id: string, n: number) => ({ id, file: `/app/${id}.tsx`, jinja: 'a'.repeat(n) })
  expect(templateBudgetViolations([t('a', 100)], 100, '/app')).toEqual([])
  expect(templateBudgetViolations([t('a', 101)], 0, '/app')).toEqual([])
  const v = templateBudgetViolations([t('a', 101), t('b', 300), t('c', 50)], 100, '/app')
  expect(v).toEqual([
    'b.jinja is 300 bytes (0.0 MB), over [build] template_max_bytes = 100 (b.tsx)',
    'a.jinja is 101 bytes (0.0 MB), over [build] template_max_bytes = 100 (a.tsx)',
    'a template grows with what a page inlines; see https://brust.dev/docs/cli#large-templates',
  ])
  // multi-byte text counts in bytes
  expect(templateBudgetViolations([{ id: 'm', file: '/app/m.tsx', jinja: 'é'.repeat(60) }], 100, '/app')).toHaveLength(2)
})
