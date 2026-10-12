import { expect, test } from 'bun:test'
import { redact } from '../src/redact'

test('redact keeps host:port only', () => {
  expect(redact('rediss://u:s3cr3t@h:6380/0?x=1')).toBe('h:6380')
  expect(redact('redis://h')).toBe('h')
  expect(redact('not a url')).toBe('<invalid url>')
})
