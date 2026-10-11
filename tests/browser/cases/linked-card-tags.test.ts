import { expect, test } from 'bun:test'
import { $$, build, load } from '../harness.ts'

// Review of F70 (repro d8t): a client-added row of a linked child paints its own nested tags.
const cards = () => $$('section').filter((s) => !s.hasAttribute('hidden'))
const tags = (s: Element) => [...s.querySelectorAll('b')].map((b) => b.textContent)

test('linked-card-tags: the added card carries its own tags, not the template row\'s', async () => {
  const m = await load(build('linked-card-tags'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect(cards().map(tags)).toEqual([['x'], ['y', 'z']])
  $$('button')[0]!.click()
  expect(cards().map(tags)).toEqual([['x'], ['y', 'z'], ['p', 'q']])
  expect(m.warnings).toEqual([])
})
