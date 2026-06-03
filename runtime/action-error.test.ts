import { test, expect } from 'bun:test'
import { ActionError, isActionError } from './action-error.ts'

test('ActionError: status/code/default message', () => {
  const e = new ActionError(409, 'TEAM_FULL')
  expect(e.status).toBe(409)
  expect(e.code).toBe('TEAM_FULL')
  expect(e.message).toBe('TEAM_FULL') // default = code
  expect(e.data).toBeUndefined()
  expect(e instanceof Error).toBe(true)
  expect(e.name).toBe('ActionError')
})

test('ActionError: explicit message + data', () => {
  const e = new ActionError(400, 'BAD', { message: 'nope', data: { a: 1 } })
  expect(e.message).toBe('nope')
  expect(e.data).toEqual({ a: 1 })
})

test('isActionError: true for instances', () => {
  expect(isActionError(new ActionError(400, 'X'))).toBe(true)
})

test('isActionError: false for non-branded', () => {
  expect(isActionError({ status: 409, code: 'X' })).toBe(false)
  expect(isActionError(new Error('x'))).toBe(false)
  expect(isActionError(null)).toBe(false)
  expect(isActionError('s')).toBe(false)
  expect(isActionError(undefined)).toBe(false)
})

test('isActionError: true for hand-branded object (Symbol.for contract)', () => {
  expect(isActionError({ [Symbol.for('brust.actionError')]: true })).toBe(true)
})
