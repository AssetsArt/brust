// F140: a page build that runs past the timeout is killed and recorded as `failed: timeout`, so a hung build cannot
// hang the generator or CI. (A light file: run.test.ts surveys every page at import.)
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { BUILD_TIMEOUT_MS, timedOut } from './app.ts'

test('the per-page build timeout is 120 s unless overridden', () => {
  if (process.env.BRUST_SHADCN_BUILD_TIMEOUT_MS === undefined) expect(BUILD_TIMEOUT_MS).toBe(120_000)
  expect(BUILD_TIMEOUT_MS).toBeGreaterThan(0)
})

test('timedOut is true only for a child killed by the timeout', () => {
  const hung = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 200, killSignal: 'SIGKILL' })
  expect(timedOut(hung)).toBe(true)
  const fast = spawnSync(process.execPath, ['-e', ''], { timeout: 20_000, killSignal: 'SIGKILL' })
  expect(timedOut(fast)).toBe(false)
  const failing = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { timeout: 20_000, killSignal: 'SIGKILL' })
  expect(failing.status).toBe(3)
  expect(timedOut(failing)).toBe(false)
})
