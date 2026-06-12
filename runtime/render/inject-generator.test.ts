import { describe, expect, test } from 'bun:test'
import { injectGeneratorMeta } from './inject-generator.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const TAG = '<meta name="generator" content="brust 9.9.9"/>'
const body = (s: string) => ENC.encode(s)

describe('injectGeneratorMeta', () => {
  test('inserts before </head>', () => {
    const out = injectGeneratorMeta(
      body('<html><head><title>x</title></head><body></body></html>'),
      TAG,
    )
    expect(DEC.decode(out)).toBe(`<html><head><title>x</title>${TAG}</head><body></body></html>`)
  })
  test('null/empty tag → untouched', () => {
    const src = body('<head></head>')
    expect(injectGeneratorMeta(src, null)).toBe(src)
    expect(injectGeneratorMeta(src, '')).toBe(src)
  })
  test('no </head> → untouched', () => {
    const src = body('<div>chunk</div>')
    expect(injectGeneratorMeta(src, TAG)).toBe(src)
  })
  test('dupe guard: existing generator meta wins', () => {
    const src = body('<head><meta name="generator" content="custom"/></head>')
    expect(injectGeneratorMeta(src, TAG)).toBe(src)
  })
  test('multibyte content before </head> keeps byte alignment', () => {
    const out = injectGeneratorMeta(body('<head><title>สวัสดี</title></head>'), TAG)
    expect(DEC.decode(out)).toBe(`<head><title>สวัสดี</title>${TAG}</head>`)
  })
})
