import { test, expect } from 'bun:test'
import { notFound, redirect, isNativeVerdict } from './routes.ts'

test('notFound() → 404 verdict, render true, empty data', () => {
  const v = notFound()
  expect(isNativeVerdict(v)).toBe(true)
  expect(v.status).toBe(404)
  expect(v.render).toBe(true)
  expect(v.data).toEqual({})
})
test('notFound(data) carries data', () => {
  const v = notFound({ user: 'bob' })
  expect(v.data).toEqual({ user: 'bob' })
})
test('redirect() → 302, render false, Location header', () => {
  const v = redirect('/x')
  expect(v.status).toBe(302)
  expect(v.render).toBe(false)
  expect(v.headers).toEqual({ Location: '/x' })
})
test('redirect(url, 301) → 301', () => {
  expect(redirect('/x', 301).status).toBe(301)
})
test('isNativeVerdict false for plain / null / data with status key', () => {
  expect(isNativeVerdict(null)).toBe(false)
  expect(isNativeVerdict({})).toBe(false)
  expect(isNativeVerdict({ status: 404 })).toBe(false)
})
