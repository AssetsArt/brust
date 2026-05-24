import { test, expect } from 'bun:test'
import { withMiddleware, getActionMiddleware, isValidActionId } from './actions.ts'
import type { Middleware } from './routes.ts'

const mwA: Middleware = async (_req, next) => next()
const mwB: Middleware = async (_req, next) => next()

test('withMiddleware returns the same function reference', () => {
  const fn = async (_req: unknown) => 'ok'
  const wrapped = withMiddleware([mwA], fn)
  expect(wrapped).toBe(fn)
})

test('withMiddleware stores the middleware array on the fn', () => {
  const fn = async (_req: unknown) => 'ok'
  withMiddleware([mwA, mwB], fn)
  expect(getActionMiddleware(fn)).toEqual([mwA, mwB])
})

test('getActionMiddleware returns undefined for unwrapped fns', () => {
  const fn = async (_req: unknown) => 'ok'
  expect(getActionMiddleware(fn)).toBeUndefined()
})

test('withMiddleware rejects non-array mws', () => {
  const fn = async (_req: unknown) => 'ok'
  expect(() => withMiddleware('nope' as any, fn)).toThrow(TypeError)
})

test('withMiddleware rejects mws containing non-functions', () => {
  const fn = async (_req: unknown) => 'ok'
  expect(() => withMiddleware([mwA, 'nope' as any], fn)).toThrow(TypeError)
})

test('withMiddleware rejects double-wrap with a clear message', () => {
  const fn = async (_req: unknown) => 'ok'
  withMiddleware([mwA], fn)
  expect(() => withMiddleware([mwB], fn)).toThrow(/called twice/)
})

test('withMiddleware result freezes the middleware array', () => {
  const fn = async (_req: unknown) => 'ok'
  const mws = [mwA]
  withMiddleware(mws, fn)
  const stored = getActionMiddleware(fn)!
  expect(Object.isFrozen(stored)).toBe(true)
  // Mutating the input does NOT affect the stored copy.
  mws.push(mwB)
  expect(getActionMiddleware(fn)).toHaveLength(1)
})

test('isValidActionId stays unchanged', () => {
  // sanity: this test guards against accidental edits to the charset helper
  expect(isValidActionId('createNote')).toBe(true)
  expect(isValidActionId('a.b')).toBe(false)
})
