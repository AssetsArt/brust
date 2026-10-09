import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

test('product-card: precompute seeds the paint; + updates the total through fmt', async () => {
  const m = await load(build('product-card'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect($('h2').textContent).toBe('a"b</script>')          // escaped on the way in, intact in the DOM
  expect($('.unit').textContent).toBe('$12.50')
  expect($('.total').textContent).toBe('Total: $12.50')
  $('button').click()
  expect($('.total').textContent).toBe('Total: $25.00')
  $('button').click()
  expect($('.total').textContent).toBe('Total: $37.50')
  expect($('.unit').textContent).toBe('$12.50')              // props-only value does not move
  expect(m.warnings).toEqual([])                                    // the interactions raised nothing either
})
