import { expect, test } from 'bun:test'
import { $, $$, build, load } from '../harness.ts'

// F32: rows and the conditional row sit directly in <tbody>; no wrapper element is left for the HTML parser to foster-parent.
const rows = () => $$('tbody > tr').filter((r) => !r.hasAttribute('hidden'))

test('table-rows: rows and the state-driven row are direct children of tbody', async () => {
  const m = await load(build('table-rows'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect(rows().map((r) => r.textContent)).toEqual(['A', 'B'])
  expect($$('tbody > *').every((e) => e.tagName === 'TR')).toBe(true)
  expect($$('brust-row, brust-if').length).toBe(0)
  $('button').click()
  expect(rows().map((r) => r.textContent)).toEqual(['A', 'B', '2'])
  expect(rows()[2]!.className).toBe('total')
  expect($('tbody').children.length).toBeGreaterThanOrEqual(3)
  $('button').click()
  expect(rows().map((r) => r.textContent)).toEqual(['A', 'B'])
  expect(m.warnings).toEqual([])
})
