import { expect, test } from 'bun:test'
import { $, $$, build, load } from '../harness.ts'

const tds = () => $$('td').filter((t) => !t.hasAttribute('hidden')).map((t) => t.textContent)

test('nested-list: inner x-for reads the outer row (F29) and state re-renders the cells', async () => {
  const m = await load(build('nested-list'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect(tds()).toEqual(['2.0kg #0', '4.0kg #0', '6.0kg #1'])      // cells x scale 2
  const rowTwoCell = $$('tr')[1]!.querySelector('td')!
  $('table').click()                                                // scale 3
  expect(tds()).toEqual(['3.0kg #0', '6.0kg #0', '9.0kg #1'])
  expect($$('tr')[1]!.querySelector('td')).toBe(rowTwoCell)         // same node, new text
})
