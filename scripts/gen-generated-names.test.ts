// F264: the generated-names fixture is generated, so it can be re-blessed; this keeps it, the Rust table and the Chromium
// test's copy from drifting apart.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { chromiumNames, generate, OUT, ROLES, rustNames } from './gen-generated-names'

test('the committed fixture is what the generator writes (re-bless: bun scripts/gen-generated-names.ts)', () => {
  expect(readFileSync(OUT, 'utf8') === generate()).toBe(true)
})

test('the Chromium test lists the same names as the cargo test', () => {
  expect(chromiumNames()).toEqual(rustNames())
})

test('one component per (name, role) and the page renders each', () => {
  const names = rustNames()
  const text = generate()
  expect(names.length).toBeGreaterThan(0)
  expect(text.match(/^function C/gm)?.length).toBe(names.length * ROLES.length)
  expect(text.match(/^ {6}<C/gm)?.length).toBe(names.length * ROLES.length)
})

test('a missing or empty table is an error, never an empty fixture', () => {
  expect(() => rustNames('const OTHER: &[&str] = &["a"];')).toThrow('NAMES not found')
  expect(() => rustNames('const NAMES: &[&str] = &[];')).toThrow('empty')
  expect(() => chromiumNames('const X = []')).toThrow('NAMES not found')
})
