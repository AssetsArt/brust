import { beforeAll, beforeEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { __resetRefsForTest, bumpRefGeneration, mintRef, resolveTarget } from './refs.ts'

beforeAll(() => {
  const win = new Window({ url: 'http://localhost/' })
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError = TypeError
  Object.assign(globalThis, { window: win, document: win.document, Element: win.Element })
})

beforeEach(() => {
  document.body.innerHTML = ''
  __resetRefsForTest()
})

test('refs resolve while connected and become stale after a generation bump', () => {
  const button = document.createElement('button')
  document.body.append(button)
  const ref = mintRef(button)
  expect(resolveTarget(ref)).toBe(button)
  bumpRefGeneration()
  expect(resolveTarget(ref)).toEqual({
    ok: false,
    error: {
      code: 'stale-ref',
      message: `ref ${ref} is no longer valid`,
      hint: 're-run Brust.struct()',
    },
  })
})

test('selectors return not-found, ambiguous, and bad-input envelopes', () => {
  document.body.innerHTML = '<button></button><button></button>'
  expect(resolveTarget('button')).toMatchObject({ ok: false, error: { code: 'ambiguous' } })
  expect(resolveTarget('#missing')).toMatchObject({ ok: false, error: { code: 'not-found' } })
  expect(resolveTarget('[')).toMatchObject({ ok: false, error: { code: 'bad-input' } })
})
