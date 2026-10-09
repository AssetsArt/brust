import { expect, test } from 'bun:test'
import { $, $$, build, load } from '../harness.ts'

test('parent-counter: reactive prop reaches the child and the function prop resets the parent', async () => {
  const m = await load(build('parent-counter'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  const [child, plus] = $$('button')
  expect(child!.textContent).toBe('0')
  plus!.click(); plus!.click()
  expect(child!.textContent).toBe('2')                        // child reads the parent's state
  child!.click()                                              // child's onClick is the parent's onReset
  expect(child!.textContent).toBe('0')
  plus!.click()
  expect(child!.textContent).toBe('1')
  expect($('section').getAttribute('x-data')).not.toBe($$('button')[0]!.getAttribute('x-data'))
  expect(m.warnings).toEqual([])                                    // the interactions raised nothing either
})
