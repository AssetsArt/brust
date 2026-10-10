import { expect, test } from 'bun:test'
import { $$, build, load } from '../harness.ts'

// Review of F70 (repro d8s): a stateless child's own prop list of static children keeps its rows
// and their bindings, because the parent re-creates the prop (x-props-bind) on the client.
const names = () => $$('li').filter((l) => !l.hasAttribute('hidden')).map((l) => l.textContent)

test('linked-list-child-rows: a row added in the parent shows up in the child list', async () => {
  const m = await load(build('linked-list-child-rows'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect(names()).toEqual(['Ada', 'Bob'])
  $$('button')[0]!.click()
  expect(names()).toEqual(['Ada', 'Bob', 'Zed'])
  expect(m.warnings).toEqual([])
})
