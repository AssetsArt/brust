import { test, expect } from 'bun:test'
import { parseArgs } from '../runtime/cli/new.ts'
import path from 'node:path'

test('parseArgs: positional name → targetDir = cwd/<name>', () => {
  const result = parseArgs(['my-app'])
  expect(result.projectName).toBe('my-app')
  expect(result.targetDir).toBe(path.resolve(process.cwd(), 'my-app'))
})

test('parseArgs: --dir overrides target', () => {
  const result = parseArgs(['my-app', '--dir', '/tmp/foo'])
  expect(result.targetDir).toBe('/tmp/foo')
})

test('parseArgs: --dir=value form', () => {
  const result = parseArgs(['my-app', '--dir=/tmp/bar'])
  expect(result.targetDir).toBe('/tmp/bar')
})

test('parseArgs: relative --dir resolved against cwd', () => {
  const result = parseArgs(['my-app', '--dir', './subdir'])
  expect(result.targetDir).toBe(path.resolve(process.cwd(), 'subdir'))
})

test('parseArgs: missing name throws', () => {
  expect(() => parseArgs([])).toThrow(/missing project name/)
})

test('parseArgs: unknown flag throws', () => {
  expect(() => parseArgs(['my-app', '--bogus'])).toThrow(/unknown flag/)
})

test('parseArgs: --dir without value throws', () => {
  expect(() => parseArgs(['my-app', '--dir'])).toThrow(/--dir requires a value/)
})

test('parseArgs: invalid project name throws (uppercase)', () => {
  expect(() => parseArgs(['MyApp'])).toThrow(/invalid project name/)
})

test('parseArgs: invalid project name throws (starts with hyphen)', () => {
  expect(() => parseArgs(['-foo'])).toThrow(/unknown flag/)
})

test('parseArgs: invalid project name throws (space)', () => {
  expect(() => parseArgs(['foo bar'])).toThrow(/invalid project name/)
})

test('parseArgs: digit-start name is valid', () => {
  const result = parseArgs(['1-foo'])
  expect(result.projectName).toBe('1-foo')
})

test('parseArgs: name too long throws', () => {
  const long = 'a'.repeat(51)
  expect(() => parseArgs([long])).toThrow(/too long/)
})
