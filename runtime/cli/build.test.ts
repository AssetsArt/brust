import { test, expect } from 'bun:test'
import { resolve } from 'node:path'
import {
  selectNativeBinaries,
  hostTargetInfix,
  VALID_TARGETS,
  parseArgs,
  buildBanner,
} from './build.ts'

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

test('parseArgs: no flag → ssg false, ssgOut null', () => {
  const p = parseArgs([])
  expect(p.ssg).toBe(false)
  expect(p.ssgOut).toBeNull()
})
test('parseArgs: --ssg → ssg true (ssgOut stays null, computed later)', () => {
  const p = parseArgs(['--ssg'])
  expect(p.ssg).toBe(true)
  expect(p.ssgOut).toBeNull()
})
test('parseArgs: --ssg-out <dir> captured as an absolute path', () => {
  const p = parseArgs(['--ssg', '--ssg-out', 'custom'])
  expect(p.ssgOut).toBe(resolve(process.cwd(), 'custom'))
})
test('parseArgs: --ssg-out=<dir> form captured', () => {
  const p = parseArgs(['--ssg', '--ssg-out=custom'])
  expect(p.ssgOut).toBe(resolve(process.cwd(), 'custom'))
})
test('parseArgs: --ssg-out without value → throws', () => {
  expect(() => parseArgs(['--ssg', '--ssg-out'])).toThrow('--ssg-out requires a value')
})
test('parseArgs: --ssg-out without --ssg → throws', () => {
  expect(() => parseArgs(['--ssg-out', 'custom'])).toThrow('--ssg-out requires --ssg')
})
test('parseArgs: --out-dir without value → throws (shared error shape)', () => {
  expect(() => parseArgs(['--out-dir'])).toThrow('--out-dir requires a value')
})
test('parseArgs: unknown flag → throws', () => {
  expect(() => parseArgs(['--bogus'])).toThrow('unknown flag')
})
test('--no-generator-version sets generatorVersion false', () => {
  const p = parseArgs(['--no-generator-version'])
  expect(p.generatorVersion).toBe(false)
})
test('generatorVersion defaults to true', () => {
  const p = parseArgs([])
  expect(p.generatorVersion).toBe(true)
})

test('buildBanner: --ai appends BRUST_AI override; default banner does not', () => {
  expect(buildBanner(true)).toContain("process.env.BRUST_AI ??= '1';")
  expect(buildBanner(false)).not.toContain("process.env.BRUST_AI ??= '1';")
})
