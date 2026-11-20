import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

// F579: a hook module's `export function` helper carried into the chunk runs (it was printed with its `export`, a
// SyntaxError); F578 D3: the hook's omitted defaulted parameter has its default in the browser.
test('hook-exported-helper: the click runs the exported helper with the default mark', async () => {
  const m = await load(build('hook-exported-helper'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  expect($('#out').textContent).toBe('pika')
  $<HTMLButtonElement>('#go').click()
  expect($('#out').textContent).toBe('PIKA!')
  $<HTMLButtonElement>('#go').click()
  expect($('#out').textContent).toBe('PIKA!!')
  expect(m.warnings).toEqual([])
})
