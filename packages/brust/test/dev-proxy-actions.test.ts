// F475 lane B: which requests the dev proxy exempts from Bun's idle timeout, and how large a body it admits.
import { expect, test } from 'bun:test'
import { PROXY_MAX_BODY_BYTES, underPrefix } from '../src/dev/proxy'

test('underPrefix: the prefix itself and its subtree, not a sibling that shares the spelling', () => {
  expect(underPrefix('/api', '/api')).toBe(true)
  expect(underPrefix('/api/upload', '/api')).toBe(true)
  expect(underPrefix('/apix', '/api')).toBe(false)
  expect(underPrefix('/other/api', '/api')).toBe(false)
  expect(underPrefix('/_brust/action/x', '/_brust/action')).toBe(true)
})

test('underPrefix: the root prefix is everything', () => {
  expect(underPrefix('/', '/')).toBe(true)
  expect(underPrefix('/any/path', '/')).toBe(true)
})

test('the proxy admits bodies up to the largest max_stream_bytes (4 GiB), not Bun\'s 128 MiB default', () => {
  expect(PROXY_MAX_BODY_BYTES).toBe(4 * 1024 ** 3)
  expect(PROXY_MAX_BODY_BYTES).toBeGreaterThan(128 * 1024 ** 2)
})
