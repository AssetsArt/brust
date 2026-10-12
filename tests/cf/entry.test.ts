// Ruling D3: lane 4's entry generator, driven with cf-min's paths and CONFIG, emits
// tests/fixtures/cf-min/cf/brust-app.entry.js byte for byte (the contract v1 entry, `install` included).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfEntrySource } from '../../packages/brust/src/build/cf-entry'
import { CF_MIN_ENTRY_INPUT } from './entry-input'

const FILE = join(import.meta.dir, '..', 'fixtures', 'cf-min', 'cf', 'brust-app.entry.js')

test('cfEntrySource(cf-min) is the fixture entry byte for byte', () => {
  expect(cfEntrySource(CF_MIN_ENTRY_INPUT)).toBe(readFileSync(FILE, 'utf8'))
})

test('the fixture entry carries the six contract exports and the install re-export', () => {
  const src = readFileSync(FILE, 'utf8')
  expect(src.match(/^export const (loader|jobs|action|MANIFEST|TEMPLATES|CONFIG) /gm)?.length).toBe(6)
  expect(src).toContain('export { install } from "@brust/core/server-handlers"')
  expect(JSON.parse(JSON.parse(src.match(/^export const CONFIG = (.*)$/m)![1])).abi).toBe(1)
})
