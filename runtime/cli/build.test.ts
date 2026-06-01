import { test, expect } from 'bun:test'
import { selectNativeBinaries, hostTargetInfix, VALID_TARGETS } from './build.ts'

const FIX = ['/x/brust.darwin-arm64.node', '/x/brust.linux-x64-gnu.node']

test('all → every collected binary', () => {
  const { selected, errors } = selectNativeBinaries(FIX, 'all')
  expect(errors).toEqual([])
  expect(selected.sort()).toEqual([...FIX].sort())
})
test('explicit single target', () => {
  const { selected, errors } = selectNativeBinaries(FIX, 'darwin-arm64')
  expect(errors).toEqual([])
  expect(selected).toEqual(['/x/brust.darwin-arm64.node'])
})
test('explicit comma list', () => {
  const { selected } = selectNativeBinaries(FIX, 'linux-x64-gnu,darwin-arm64')
  expect(selected.length).toBe(2)
})
test('duplicate tokens select once', () => {
  const { selected, errors } = selectNativeBinaries(FIX, 'darwin-arm64,darwin-arm64')
  expect(errors).toEqual([])
  expect(selected).toEqual(['/x/brust.darwin-arm64.node'])
})
test('unknown target → error', () => {
  const { errors } = selectNativeBinaries(FIX, 'win32-x64')
  expect(errors.join()).toContain('unknown target')
})
test('valid but absent target → error', () => {
  const { errors } = selectNativeBinaries(FIX, 'linux-arm64-musl')
  expect(errors.join()).toContain('no native binary')
})
test('auto + all not combinable', () => {
  const { errors } = selectNativeBinaries(FIX, 'auto,all')
  expect(errors.length).toBeGreaterThan(0)
})
test('auto selects the host binary when present', () => {
  const host = hostTargetInfix()
  // Use a second fixture entry that is guaranteed to differ from host.
  const other = VALID_TARGETS.find((t) => t !== host) ?? 'linux-x64-gnu'
  const fix = [`/x/brust.${host}.node`, `/x/brust.${other}.node`]
  const { selected, errors } = selectNativeBinaries(fix, 'auto')
  expect(errors).toEqual([])
  expect(selected).toEqual([`/x/brust.${host}.node`])
})
test('VALID_TARGETS has the 6 published targets', () => {
  expect(VALID_TARGETS.length).toBe(6)
})
