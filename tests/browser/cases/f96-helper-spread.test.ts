import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

test('f96-helper-spread (F96b): spreading a state array in a handler or helper works', async () => {
  const m = await load(build('f96-helper-spread'))
  expect(m.warnings).toEqual([])
  expect($('#n').textContent).toBe('3')
  expect($('#top').textContent).toBe('3')
  $('button').click()
  expect($('#n').textContent).toBe('4')
  expect($('#top').textContent).toBe('4')
})
