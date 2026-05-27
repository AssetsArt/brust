import { describe, test, expect, spyOn } from 'bun:test'
import { injectDevClient, _resetWarnedForTests } from './inject-dev-client.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const body = (s: string) => enc.encode(s)
const str = (b: Uint8Array) => dec.decode(b)

describe('injectDevClient', () => {
  test('splices the snippet immediately before </head>', () => {
    const out = injectDevClient(
      body('<head><title>x</title></head><body></body>'),
      '<script>devclient</script>',
    )
    expect(str(out)).toBe(
      '<head><title>x</title><script>devclient</script></head><body></body>',
    )
  })

  test('matches case-insensitive </HEAD>', () => {
    const out = injectDevClient(
      body('<HEAD></HEAD>'),
      '<script>x</script>',
    )
    expect(str(out)).toBe('<HEAD><script>x</script></HEAD>')
  })

  test('returns the original body when snippet is null', () => {
    const src = body('<head></head>')
    const out = injectDevClient(src, null)
    expect(out).toBe(src)
  })

  test('returns the original body when snippet is empty string', () => {
    const src = body('<head></head>')
    const out = injectDevClient(src, '')
    expect(out).toBe(src)
  })

  test('returns body unchanged + warns once when </head> is missing', () => {
    _resetWarnedForTests()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = body('<body>no head</body>')
      const out = injectDevClient(src, '<script>x</script>')
      expect(out).toBe(src)
      expect(warn).toHaveBeenCalledTimes(1)

      injectDevClient(body('<body></body>'), '<script>x</script>')
      expect(warn).toHaveBeenCalledTimes(1)  // still 1
    } finally {
      warn.mockRestore()
    }
  })

  test('preserves UTF-8 multibyte content preceding </head>', () => {
    const out = injectDevClient(
      body('<head><title>こんにちは</title></head>'),
      '<script>x</script>',
    )
    expect(str(out)).toBe('<head><title>こんにちは</title><script>x</script></head>')
  })

  test('output is a plain Uint8Array', () => {
    const out = injectDevClient(body('<head></head>'), '<script>x</script>')
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out.constructor.name).toBe('Uint8Array')
  })
})
