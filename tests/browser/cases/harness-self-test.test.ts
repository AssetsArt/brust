// Negative control for the harness itself: a warning or error raised AFTER mount must be
// captured, and `warnOnce` must be able to fire again in the next case.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { build, load, repo } from '../harness.ts'

const { warnOnce } = await import(join(repo, 'packages/runtime-dom/src/warn.ts'))

test('harness: console.error and warnOnce after mount land in m.warnings', async () => {
  const m = await load(build('theme-toggle'))
  expect(m.warnings).toEqual([])
  console.error('[brust] probe')
  warnOnce('probe', 'probe')
  expect(m.warnings).toEqual(['error: [brust] probe', 'warn: [brust] probe'])
})

test('harness: warnOnce is reset between cases', async () => {
  const m = await load(build('theme-toggle'))
  expect(m.warnings).toEqual([])
  warnOnce('probe', 'probe')
  expect(m.warnings).toEqual(['warn: [brust] probe'])
})
