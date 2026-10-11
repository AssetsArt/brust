import { expect, test } from 'bun:test'
import { $$, build, instanceOf, load } from '../harness.ts'

// F71: the host seeds the projected rows (id, name — never secret); the list still keys, re-binds
// and reorders by identity on the projected objects.
const lis = () => $$('li').filter((l) => !l.hasAttribute('hidden'))

test('reactive-list-rows: projected x-props drive the keyed list', async () => {
  const m = await load(build('reactive-list-rows'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  const host = $$('ul')[0]!
  expect(host.getAttribute('x-props')).not.toContain('secret')
  const props = instanceOf(host).props
  expect((props() as { rows: object[] }).rows).toEqual([
    { id: 'a', name: 'Ada' },
    { id: 'b', name: 'Bob' },
  ])
  lis()[1]!.click()
  expect(lis().map((l) => l.className)).toEqual(['', 'on'])
  const [a, b] = lis()
  props.set({ rows: [{ id: 'b', name: 'Bob' }, { id: 'a', name: 'Ada' }] })
  expect(lis()).toEqual([b!, a!])
  expect(lis().map((l) => l.className)).toEqual(['on', ''])
  expect(m.warnings).toEqual([])
})
