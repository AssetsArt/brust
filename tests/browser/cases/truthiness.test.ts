import { expect, test } from 'bun:test'
import { $, $$, build, load } from '../harness.ts'

const buttons = () => $$('button')

test('truthiness: x-if on a reactive flag toggles (F30), [] is truthy, children are independent', async () => {
  const m = await load(build('truthiness'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect($('p')?.textContent).toBe('has-list')                      // React: [] is truthy
  expect($('b')).toBeNull()                                         // closed: only the hidden template
  const [toggle, c1, c2] = buttons()
  expect([c1!.textContent, c2!.textContent]).toEqual(['5', '10'])
  toggle!.click()
  expect($('brust-if:not([hidden]) b')?.textContent).toBe('bold')   // inserted clone is visible
  expect($('div')!.textContent).toContain('text-branch')
  toggle!.click()
  expect($('brust-if:not([hidden]) b')).toBeNull()
  expect($('div')!.textContent).not.toContain('text-branch')
  toggle!.click()
  expect($('brust-if:not([hidden]) b')?.textContent).toBe('bold')   // shown again after a hide
  c1!.click(); c1!.click()
  expect([c1!.textContent, c2!.textContent]).toEqual(['7', '10'])   // each child owns its state
  c2!.click()
  expect([c1!.textContent, c2!.textContent]).toEqual(['7', '11'])
})
