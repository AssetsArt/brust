import { expect, test } from 'bun:test'
import { $, $$, build, load } from '../harness.ts'

test('f96-linked-list-child (F96d): a static child listing a state-fed prop repaints', async () => {
  const m = await load(build('f96-linked-list-child'))
  expect(m.warnings).toEqual([])
  expect($$('li').map((l) => l.textContent)).toEqual(['a'])
  $('button').click()
  expect($$('li').map((l) => l.textContent)).toEqual(['a', 'b'])
})
