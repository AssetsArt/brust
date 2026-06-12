import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  generatorStrings,
  insertGeneratorMeta,
  readGeneratorArtifact,
  resolveGenerator,
  writeGeneratorArtifact,
} from './generator.ts'

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1"/>'

describe('generatorStrings', () => {
  test('version on: meta + header carry the brustjs package version', () => {
    const g = generatorStrings(true)
    expect(g.meta).toMatch(/^<meta name="generator" content="brust [0-9A-Za-z.+-]+"\/>$/)
    expect(g.header).toMatch(/^brust\/[0-9A-Za-z.+-]+$/)
  })
  test('version off: name only', () => {
    const g = generatorStrings(false)
    expect(g.meta).toBe('<meta name="generator" content="brust"/>')
    expect(g.header).toBe('brust')
  })
})

describe('insertGeneratorMeta', () => {
  const TAG = '<meta name="generator" content="brust 9.9.9"/>'
  test('inserts immediately after the viewport anchor', () => {
    const jinja = `<html><head><meta charset="utf-8"/>${VIEWPORT}<title>x</title></head></html>`
    const out = insertGeneratorMeta(jinja, TAG)
    expect(out).toBe(
      `<html><head><meta charset="utf-8"/>${VIEWPORT}${TAG}<title>x</title></head></html>`,
    )
  })
  test('no anchor → no-op, never throws', () => {
    expect(insertGeneratorMeta('<div>fragment</div>', TAG)).toBe('<div>fragment</div>')
  })
  test('only the FIRST anchor is used', () => {
    const jinja = `${VIEWPORT}${VIEWPORT}`
    const out = insertGeneratorMeta(jinja, TAG)
    expect(out).toBe(`${VIEWPORT}${TAG}${VIEWPORT}`)
  })
})

describe('artifact round-trip', () => {
  test('write → read returns the same strings; resolve falls back when missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brust-gen-'))
    const g = generatorStrings(false)
    writeGeneratorArtifact(dir, g)
    expect(readGeneratorArtifact(dir)).toEqual(g)
    expect(resolveGenerator(dir)).toEqual(g)
    const missing = path.join(dir, 'nope')
    expect(readGeneratorArtifact(missing)).toBeNull()
    expect(resolveGenerator(missing)).toEqual(generatorStrings(true))
  })
  test('malformed artifact → null → fallback', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brust-gen-'))
    writeFileSync(path.join(dir, 'generator.json'), '{"meta": 7}')
    expect(readGeneratorArtifact(dir)).toBeNull()
    expect(resolveGenerator(dir)).toEqual(generatorStrings(true))
  })
})
