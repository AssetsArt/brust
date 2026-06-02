import { expect, test } from 'bun:test'
import { parseStoreScript, storeScriptTag, toScriptJson } from './serialize.ts'

test('toScriptJson round-trips via JSON.parse', () => {
  const out = toScriptJson({ a: 1, b: 'two', c: [3, 4] })
  expect(JSON.parse(out)).toEqual({ a: 1, b: 'two', c: [3, 4] })
})

test('a value containing </script> emits no literal </script>', () => {
  const out = toScriptJson({ x: '</script><script>alert(1)</script>' })
  expect(out.includes('</script>')).toBe(false)
  expect(out.includes('\\u003c/script\\u003e')).toBe(true)
  // still parses back to the original string
  expect((JSON.parse(out) as { x: string }).x).toBe('</script><script>alert(1)</script>')
})

test('<!--, &, U+2028, U+2029 are escaped', () => {
  const out = toScriptJson({ a: '<!--', b: '&', c: ' ', d: ' ' })
  expect(out.includes('<!--')).toBe(false)
  expect(out.includes('\\u0026')).toBe(true)
  expect(out.includes('\\u2028')).toBe(true)
  expect(out.includes('\\u2029')).toBe(true)
  expect(out.includes(' ')).toBe(false)
  expect(out.includes(' ')).toBe(false)
})

test('storeScriptTag returns a typed json script tag', () => {
  const tag = storeScriptTag('team', { x: 1 })
  expect(tag).toBe('<script type="application/json" data-brust-store="team">{"x":1}</script>')
})

test('parseStoreScript reads JSON.parse(el.textContent)', () => {
  expect(parseStoreScript({ textContent: '{"a":1}' })).toEqual({ a: 1 })
  expect(parseStoreScript({ textContent: null })).toEqual({})
})
