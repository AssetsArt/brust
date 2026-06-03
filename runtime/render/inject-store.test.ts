import { expect, test } from 'bun:test'
import { storeScriptTag } from '../store/serialize.ts'
import { _resetWarnedForTests, buildStoreScripts, injectBrustStore } from './inject-store.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// B7 — the native store-snapshot SSR path uses buildStoreScripts standalone (it
// can't post-splice the Rust fast-lane HTML, so it feeds the string into a jinja
// context var instead of injectBrustStore). Lock the contract it relies on: one
// storeScriptTag per store, byte-identical to the React path, and '' for empty.
test('buildStoreScripts equals storeScriptTag per store (native injection contract)', () => {
  expect(buildStoreScripts({ cart: { count: 1 } })).toBe(storeScriptTag('cart', { count: 1 }))
})

test('buildStoreScripts returns empty string for null / empty snapshot', () => {
  expect(buildStoreScripts(null)).toBe('')
  expect(buildStoreScripts({})).toBe('')
})

test('null snapshot → body unchanged (same reference)', () => {
  const body = ENC.encode('<html><head></head><body></body></html>')
  expect(injectBrustStore(body, null)).toBe(body)
})

test('empty snapshot → body unchanged', () => {
  const body = ENC.encode('<html><head></head></html>')
  expect(buildStoreScripts({})).toBe('')
  expect(injectBrustStore(body, {})).toBe(body)
})

test('one store → output contains data-brust-store before </head>', () => {
  const body = ENC.encode('<html><head><title>x</title></head><body>hi</body></html>')
  const out = DEC.decode(injectBrustStore(body, { team: { score: 3 } }))
  expect(out.includes('data-brust-store="team"')).toBe(true)
  expect(out.indexOf('data-brust-store="team"')).toBeLessThan(out.indexOf('</head>'))
  expect(out.includes('{"score":3}')).toBe(true)
})

test('no </head> → body unchanged (warn-once)', () => {
  _resetWarnedForTests()
  const body = ENC.encode('<html><body>no head</body></html>')
  expect(injectBrustStore(body, { team: { score: 1 } })).toBe(body)
})

test('multi-store snapshot → one <script> per store, all before </head>', () => {
  const body = ENC.encode('<html><head></head><body></body></html>')
  const out = DEC.decode(injectBrustStore(body, { a: { x: 1 }, b: { y: 2 } }))
  const headPos = out.indexOf('</head>')
  expect(out.indexOf('data-brust-store="a"')).toBeGreaterThanOrEqual(0)
  expect(out.indexOf('data-brust-store="a"')).toBeLessThan(headPos)
  expect(out.indexOf('data-brust-store="b"')).toBeGreaterThanOrEqual(0)
  expect(out.indexOf('data-brust-store="b"')).toBeLessThan(headPos)
  expect((out.match(/<script type="application\/json"/g) ?? []).length).toBe(2)
})
