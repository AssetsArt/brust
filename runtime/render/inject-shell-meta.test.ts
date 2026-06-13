import { describe, expect, test } from 'bun:test'
import { injectShellMeta } from './inject-shell-meta.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const body = (s: string) => ENC.encode(s)
const META = (id: string) => `<meta name="brust-shell" content="${id}">`

describe('injectShellMeta', () => {
  test('inserts before </head>', () => {
    const out = injectShellMeta(
      body('<html><head><title>x</title></head><body></body></html>'),
      'L:AppLayout',
    )
    expect(DEC.decode(out)).toBe(
      `<html><head><title>x</title>${META('L:AppLayout')}</head><body></body></html>`,
    )
  })

  test('empty shellId → untouched (no-op)', () => {
    const src = body('<head></head>')
    expect(injectShellMeta(src, '')).toBe(src)
  })

  test('no </head> → untouched', () => {
    const src = body('<div>chunk</div>')
    expect(injectShellMeta(src, 'S:LoginPage')).toBe(src)
  })

  test('idempotent: an existing brust-shell meta wins (byte guard)', () => {
    const src = body('<head><meta name="brust-shell" content="L:Existing"></head>')
    expect(injectShellMeta(src, 'S:Other')).toBe(src)
  })

  test('multibyte content before </head> keeps byte alignment', () => {
    const out = injectShellMeta(body('<head><title>สวัสดี</title></head>'), 'S:Thai')
    expect(DEC.decode(out)).toBe(`<head><title>สวัสดี</title>${META('S:Thai')}</head>`)
  })
})
