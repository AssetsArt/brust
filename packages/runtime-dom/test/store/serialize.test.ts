import { expect, test } from 'bun:test'
import { parseStoreScript, storeScriptTag, toScriptJson } from '../../src/store/serialize'

test('toScriptJson round-trips via JSON.parse', () => {
  const out = toScriptJson({ a: 1, b: 'two', c: [3, 4] })
  expect(JSON.parse(out)).toEqual({ a: 1, b: 'two', c: [3, 4] })
})

test('a value containing </script> emits no literal </script>', () => {
  const out = toScriptJson({ x: '</script><script>alert(1)</script>' })
  expect(out.includes('</script>')).toBe(false)
  expect(out.includes('\\u003c/script\\u003e')).toBe(true)
  expect((JSON.parse(out) as { x: string }).x).toBe('</script><script>alert(1)</script>')
})

test('<!--, &, U+2028, U+2029 are escaped', () => {
  const out = toScriptJson({ a: '<!--', b: '&', c: '\u2028', d: '\u2029' })
  expect(out.includes('<!--')).toBe(false)
  expect(out.includes('\\u0026')).toBe(true)
  expect(out.includes('\\u2028')).toBe(true)
  expect(out.includes('\\u2029')).toBe(true)
  expect(out.includes('\u2028')).toBe(false)
  expect(out.includes('\u2029')).toBe(false)
})

test('storeScriptTag returns a typed json script tag', () => {
  const tag = storeScriptTag('team', { x: 1 })
  expect(tag).toBe('<script type="application/json" data-brust-store="team">{"x":1}</script>')
})

test('parseStoreScript reads JSON.parse(el.textContent)', () => {
  expect(parseStoreScript({ textContent: '{"a":1}' })).toEqual({ a: 1 })
  expect(parseStoreScript({ textContent: null })).toEqual({})
})

test('parseStoreScript returns {} on invalid JSON without throwing', () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    expect(() => parseStoreScript({ textContent: '{bad' })).not.toThrow()
    expect(parseStoreScript({ textContent: '{bad' })).toEqual({})
  } finally {
    console.warn = warn
  }
})

test('storeScriptTag strips characters outside [A-Za-z0-9_.:-] from the name', () => {
  expect(storeScriptTag('a"b c', 1)).toContain('data-brust-store="abc"')
})

// C4: the Rust emitter in render.rs must produce these bytes exactly.
test('C4 golden bytes', () => {
  expect(storeScriptTag('cart', { n: '</script><!--&\u2028' })).toBe(
    '<script type="application/json" data-brust-store="cart">{"n":"\\u003c/script\\u003e\\u003c!--\\u0026\\u2028"}</script>',
  )
})
