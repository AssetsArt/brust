import { expect, test } from 'bun:test'
import { $$, build, instanceOf, load } from '../harness.ts'

// Spec §12 "a keyed list with per-item handlers and child props": the child's props come from the
// parent through `x-props-bind` with the row scope; its handler updates the parent; the parent's
// state flows back into the child's class.
const lis = () => $$('li').filter((l) => !l.hasAttribute('hidden'))
const selected = () => lis().map((l) => l.classList.contains('selected'))

test('keyed-list-child: per-item child props and handler through x-props-bind, across a reorder', async () => {
  const m = await load(build('keyed-list-child'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect(lis().map((l) => l.textContent)).toEqual(['Write', 'Ship', 'Rest'])
  expect(selected()).toEqual([false, false, false])
  const [write, ship, rest] = lis()
  lis()[1]!.click()                                     // child onPick -> parent setSelected -> child `selected` prop
  expect(selected()).toEqual([false, true, false])
  expect(lis().map((l) => l.textContent)).toEqual(['Write', 'Ship', 'Rest'])
  // Reorder the source (props are the list's owner): rows move, nodes and selection follow the item.
  const props = instanceOf($$('ul')[0]!).props
  const todos = (props() as { todos: { id: string }[] }).todos
  props.set({ ...props(), todos: [todos[2], todos[0], todos[1]] })
  expect(lis().map((l) => l.textContent)).toEqual(['Rest', 'Write', 'Ship'])
  expect(lis()).toEqual([rest!, write!, ship!])
  expect(selected()).toEqual([false, false, true])
  lis()[0]!.click()                                     // "Rest" is now first
  expect(selected()).toEqual([true, false, false])
  expect(m.warnings).toEqual([])                        // the interactions raised nothing either
})
