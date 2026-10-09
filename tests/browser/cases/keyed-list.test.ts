import { expect, test } from 'bun:test'
import { $$, build, instanceOf, load } from '../harness.ts'

const lis = () => $$('li')

test('keyed-list: per-item handler gets the right item; reorder keeps DOM nodes', async () => {
  const m = await load(build('keyed-list'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect(lis().map((l) => l.textContent)).toEqual(['1. Writedone', '2. Ship'])
  const [first, second] = lis()
  second!.click()
  expect(lis().map((l) => l.className)).toEqual(['', 'selected'])
  // Reorder the source (props are the list's owner): rows move, nodes are kept.
  const host = $$('ul')[0]!
  const props = instanceOf(host).props
  const todos = (props() as { todos: unknown[] }).todos
  props.set({ ...props(), todos: [todos[1], todos[0]] })
  expect(lis().map((l) => l.textContent)).toEqual(['1. Ship', '2. Writedone'])
  expect(lis()[0]).toBe(second!)
  expect(lis()[1]).toBe(first!)
  expect(lis().map((l) => l.className)).toEqual(['selected', ''])  // selection follows the item
  lis()[1]!.click()                                                // "Write" is now second
  expect(lis().map((l) => l.className)).toEqual(['', 'selected'])
})

test('keyed-list: the empty list paints no rows and still takes new ones', async () => {
  const m = await load(build('keyed-list', 'sample-props.empty.json'))
  expect(m.warnings).toEqual([])
  expect(lis().filter((l) => !l.hasAttribute('hidden'))).toEqual([])
  const host = $$('ul')[0]!
  const props = instanceOf(host).props
  props.set({ ...props(), todos: [{ id: 'z', title: 'New', done: false }] })
  expect(lis().filter((l) => !l.hasAttribute('hidden')).map((l) => l.textContent)).toEqual(['1. New'])
})
