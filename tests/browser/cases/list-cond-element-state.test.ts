import { expect, test } from 'bun:test'
import { $, $$, build, instanceOf, load } from '../harness.ts'

// L6 (G6): a `.map` callback returning `c ? <a/> : <h4/>`; the row swaps its element when the
// state or the item's href changes.
const shown = () => $$('li:not([hidden]) > a, li:not([hidden]) > h4').map((e) => `${e.tagName.toLowerCase()}:${e.textContent}`)

test('list-cond-element-state: toggling swaps <a> and <h4> inside each row', async () => {
  const m = await load(build('list-cond-element-state'))
  expect(m.warnings).toEqual([])
  expect(shown()).toEqual(['a:Docs', 'h4:Plain'])
  $('button').click()
  expect(shown()).toEqual(['h4:Docs', 'h4:Plain'])
  $('button').click()
  expect(shown()).toEqual(['a:Docs', 'h4:Plain'])
})

test('list-cond-element-state: an item that gains an href becomes a link', async () => {
  const m = await load(build('list-cond-element-state'))
  expect(m.warnings).toEqual([])
  const props = instanceOf($('div')).props
  const items = (props() as { items: { id: string; title: string; href?: string }[] }).items
  props.set({ ...props(), items: [items[0], { ...items[1]!, href: '/plain' }] })
  expect(shown()).toEqual(['a:Docs', 'a:Plain'])
  expect(m.warnings).toEqual([])
})
