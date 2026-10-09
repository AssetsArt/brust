import { expect, test } from 'bun:test'
import { $, build, load, members, type } from '../harness.ts'

test('controlled-input: typing writes state, state writes the input', async () => {
  const m = await load(build('controlled-input'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  const input = $<HTMLInputElement>('input')
  expect(input.getAttribute('placeholder')).toBe('Search')
  expect($('small')).toBeNull()                                   // x-if false: only the hidden template is left
  type(input, 'ab')
  expect($('small:not([hidden])')?.textContent).toBe('Searching for ab')
  type(input, 'abc')
  expect($('small:not([hidden])')?.textContent).toBe('Searching for abc')
  type(input, '')
  expect($('small:not([hidden])')).toBeNull()
  members($('label')).q.set('zz')                                 // state -> input
  expect(input.value).toBe('zz')
  expect($('small:not([hidden])')?.textContent).toBe('Searching for zz')
})
