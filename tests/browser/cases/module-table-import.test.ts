import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

// F564 D1/D4: a native component reading module tables built from an imported literal table (`icon: ICON.overview`),
// in markup and in handlers: the server HTML hydrates unchanged and each click shows what React shows.
test('module-table-import: tables read from an imported literal work after hydration', async () => {
  const m = await load(build('module-table-import'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect([$('#cur').getAttribute('data-icon'), $('#cur').textContent]).toEqual(['O', 'overview'])
  expect([$('#b0').title, $('#b1').title]).toEqual(['O', 'A'])
  expect($('nav').getAttribute('data-label')).toBe('/|/apps')
  $<HTMLButtonElement>('#b1').click()
  expect([$('#cur').getAttribute('data-icon'), $('#cur').textContent]).toEqual(['A', 'apps'])
  $<HTMLButtonElement>('#b0').click()
  expect([$('#cur').getAttribute('data-icon'), $('#cur').textContent]).toEqual(['O', 'overview'])
})
