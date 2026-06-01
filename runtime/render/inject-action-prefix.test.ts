import { describe, test, expect, spyOn } from 'bun:test'
import { injectActionPrefix, _resetWarnedForTests } from './inject-action-prefix.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const body = (s: string) => enc.encode(s)
const str = (b: Uint8Array) => dec.decode(b)

describe('injectActionPrefix', () => {
  test('splices the snippet immediately before </head>', () => {
    const out = injectActionPrefix(
      body('<head><title>x</title></head><body>'),
      '<script>S</script>',
    )
    expect(str(out)).toBe('<head><title>x</title><script>S</script></head><body>')
  })

  test('returns the original body when snippet is null', () => {
    const src = body('<head></head>')
    expect(injectActionPrefix(src, null)).toBe(src)
  })

  test('returns body unchanged + warns once when </head> is missing', () => {
    _resetWarnedForTests()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = body('<body>no head</body>')
      expect(str(injectActionPrefix(src, '<script>S</script>'))).toBe('<body>no head</body>')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
