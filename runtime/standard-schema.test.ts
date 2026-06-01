import { test, expect } from 'bun:test'
import { z } from 'zod'
import { validate } from './standard-schema.ts'

test('passes valid input and returns parsed value', async () => {
  const schema = z.object({ text: z.string() })
  const r = await validate(schema, { text: 'hi' })
  expect(r).toEqual({ ok: true, value: { text: 'hi' } })
})
test('fails invalid input and returns issues', async () => {
  const schema = z.object({ text: z.string() })
  const r = await validate(schema, { text: 123 })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(Array.isArray(r.issues)).toBe(true)
})
test('passthrough when schema is undefined', async () => {
  const r = await validate(undefined, { anything: true })
  expect(r).toEqual({ ok: true, value: { anything: true } })
})
