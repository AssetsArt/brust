import { describe, expect, test } from 'bun:test'
import { parseOptions } from '../src/options'

describe('parseOptions', () => {
  test('defaults (R10)', () => {
    expect(parseOptions({ url: 'redis://h' })).toEqual({
      url: 'redis://h',
      tls: false,
      connectTimeoutMs: 2000,
      maxBodyBytes: 1_048_576,
      markerTtlMs: 86_400_000,
      unlinkBatch: 500,
      reconnectMinMs: 100,
      reconnectMaxMs: 5000,
    })
  })
  test.each([
    ['connect_timeout_ms', 99],
    ['connect_timeout_ms', 60_001],
    ['max_body_bytes', 0],
    ['max_body_bytes', 67_108_865],
    ['marker_ttl_ms', 59_999],
    ['marker_ttl_ms', 604_800_001],
    ['unlink_batch', 0],
    ['unlink_batch', 10_001],
    ['reconnect_min_ms', 9],
    ['reconnect_min_ms', 1.5],
    ['reconnect_max_ms', 'x'],
  ])('%s = %p is refused, naming the key', (k, v) => {
    expect(() => parseOptions({ url: 'redis://h', [k]: v })).toThrow(new RegExp(`^TypeError: cache-redis: ${k} `))
  })
  test('boundary values pass', () => {
    const o = parseOptions({ url: 'redis://h', connect_timeout_ms: 100, max_body_bytes: 67_108_864, marker_ttl_ms: 60_000, unlink_batch: 10_000, reconnect_min_ms: 10, reconnect_max_ms: 10 })
    expect([o.connectTimeoutMs, o.maxBodyBytes, o.markerTtlMs, o.unlinkBatch, o.reconnectMinMs, o.reconnectMaxMs]).toEqual([100, 67_108_864, 60_000, 10_000, 10, 10])
  })
  test('reconnect_max_ms below min is refused; a large min lifts the default max', () => {
    expect(() => parseOptions({ url: 'redis://h', reconnect_min_ms: 200, reconnect_max_ms: 100 })).toThrow('reconnect_max_ms')
    expect(parseOptions({ url: 'redis://h', reconnect_min_ms: 9000 }).reconnectMaxMs).toBe(9000)
  })
  test('an unknown key', () => {
    expect(() => parseOptions({ url: 'redis://h', urll: 'x' })).toThrow('TypeError: cache-redis: unknown option "urll"')
  })
  test('an empty or missing url names url and never echoes a value', () => {
    for (const o of [{ url: '' }, {}, { url: '  ' }]) expect(() => parseOptions(o)).toThrow(/^TypeError: cache-redis: url is required/)
    try {
      parseOptions({ url: 'redis://:s3cr3t@h', unlink_batch: 0 })
    } catch (e) {
      expect(String(e)).not.toContain('s3cr3t')
    }
  })
  test('tls forms', () => {
    expect(parseOptions({ url: 'rediss://h', tls: true }).tls).toBe(true)
    expect(parseOptions({ url: 'rediss://h', tls: { reject_unauthorized: false, server_name: 'x' } }).tls).toEqual({ rejectUnauthorized: false, serverName: 'x' })
    expect(() => parseOptions({ url: 'rediss://h', tls: { ca_file: '/nonexistent/ca.pem' } })).toThrow(/tls\.ca_file/)
    expect(() => parseOptions({ url: 'rediss://h', tls: { foo: 1 } })).toThrow('tls.foo')
  })
})
