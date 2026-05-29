import { describe, test, expect, spyOn } from 'bun:test'
import { injectCssLink, _resetWarnedForTests } from './inject-css-link.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function body(s: string): Uint8Array {
  return enc.encode(s)
}
function str(b: Uint8Array): string {
  return dec.decode(b)
}

describe('injectCssLink', () => {
  test('splices a single <link> immediately before </head>', () => {
    const out = injectCssLink(
      body('<!DOCTYPE html><html><head><title>x</title></head><body></body></html>'),
      ['/_brust/css/app.css'],
    )
    expect(str(out)).toBe(
      '<!DOCTYPE html><html><head><title>x</title>' +
        '<link rel="stylesheet" href="/_brust/css/app.css">' +
        '</head><body></body></html>',
    )
  })

  test('matches uppercase </HEAD> case-insensitively', () => {
    const out = injectCssLink(body('<html><HEAD></HEAD></html>'), ['/x.css'])
    expect(str(out)).toBe('<html><HEAD><link rel="stylesheet" href="/x.css"></HEAD></html>')
  })

  test('emits multiple <link> tags in declaration order', () => {
    const out = injectCssLink(body('<head></head>'), ['/a.css', '/b.css'])
    expect(str(out)).toBe(
      '<head><link rel="stylesheet" href="/a.css">' +
        '<link rel="stylesheet" href="/b.css"></head>',
    )
  })

  test('returns the original body when hrefs is empty', () => {
    const src = body('<head></head>')
    const out = injectCssLink(src, [])
    expect(out).toBe(src) // referential — no work done
  })

  test('preserves UTF-8 multibyte content preceding </head>', () => {
    const out = injectCssLink(body('<head><title>こんにちは</title></head>'), ['/a.css'])
    expect(str(out)).toBe(
      '<head><title>こんにちは</title><link rel="stylesheet" href="/a.css"></head>',
    )
  })

  test('returns body unchanged when </head> is absent and warns once', () => {
    _resetWarnedForTests()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = body('<body>no head here</body>')
      const out = injectCssLink(src, ['/a.css'])
      expect(out).toBe(src)
      expect(warn).toHaveBeenCalledTimes(1)

      // Second miss: no additional warn.
      injectCssLink(body('<body></body>'), ['/a.css'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test('returns a Uint8Array, not a Buffer or other subclass', () => {
    const out = injectCssLink(body('<head></head>'), ['/a.css'])
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out.constructor.name).toBe('Uint8Array')
  })
})
