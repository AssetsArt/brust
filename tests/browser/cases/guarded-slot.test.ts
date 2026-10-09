import { expect, test } from 'bun:test'
import { $, $$, build, load } from '../harness.ts'

test('guarded-slot: a false guard paints nothing, the state-guarded branch shows on click (F67)', async () => {
  const m = await load(build('guarded-slot'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect(document.querySelector('.p')).toBeNull()                    // show=false
  expect(document.querySelector('.s')).toBeNull()                    // open=false
  const lis = $$('li')
  expect(lis[0]!.querySelector('em')).toBeNull()                     // not on sale
  expect(lis[1]!.querySelector('em')!.textContent).toBe('2.0')
  expect(document.querySelector('u')).toBeNull()                     // a && b with b=false
  $('button').click()
  expect(document.querySelector('.s')!.hasAttribute('hidden')).toBe(false)   // shown; its text is F58 (a state-guarded slot is not recomputed client-side)
  expect(m.warnings).toEqual([])
})
