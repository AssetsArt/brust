import { test, expect } from 'bun:test'
import { z } from 'zod'
import { defineActions } from './define-actions.ts'

test('accumulates endpoints with method/path/handler/schemas', () => {
  const a = defineActions()
    .post('/notes', () => ({ id: '1' }), { body: z.object({ text: z.string() }) })
    .get('/notes/{id}', ({ params }) => ({ id: params.id }))
  const eps = a.endpoints
  expect(eps.map((e) => `${e.method} ${e.path}`)).toEqual(['POST /notes', 'GET /notes/{id}'])
  expect(typeof eps[0].handler).toBe('function')
  expect(eps[0].body).toBeDefined()
})
test('global .use middleware is prepended to every endpoint chain', () => {
  const mw = async (_req: any, next: any) => next()
  const a = defineActions()
    .use(mw)
    .get('/x', () => 1)
    .post('/y', () => 2)
  expect(a.endpoints[0].middleware[0]).toBe(mw)
  expect(a.endpoints[1].middleware[0]).toBe(mw)
})
test('duplicate METHOD path throws at definition', () => {
  expect(() =>
    defineActions()
      .get('/notes/{id}', () => 1)
      .get('/notes/{id}', () => 2),
  ).toThrow(/duplicate/i)
})
test('invalid path throws', () => {
  expect(() => defineActions().get('notes', () => 1)).toThrow(/path/i)
  expect(() => defineActions().get('/a b', () => 1)).toThrow(/path/i)
})
