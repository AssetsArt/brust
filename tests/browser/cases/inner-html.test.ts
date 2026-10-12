import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

test('inner-html: first paint is stable and a click swaps the markup through x-html', async () => {
  const m = await load(build('inner-html'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)                       // mount changes nothing visible
  const out = $('#out')!
  expect(out.innerHTML).toBe('<b>bold</b>')
  const b = $('button')
  b.click()
  expect(out.innerHTML).toBe('<i>ital</i>')
  expect(out.querySelector('b')).toBeNull()
  b.click()
  expect(out.innerHTML).toBe('<b>bold</b>')
  expect(m.warnings).toEqual([])                       // the interactions raised nothing either
})
