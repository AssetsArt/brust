import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

// F578 review round 1: a function an inlined hook returns, used as a handler by member, reads the hook's defaulted
// parameter, a hook value and a hook-local arrow: all declared in the chunk (it threw a ReferenceError on the click).
test('hook-returned-fn: the returned function runs with the hook names it reads', async () => {
  const m = await load(build('hook-returned-fn'))
  expect(m.warnings).toEqual([])
  expect($('#out').textContent).toBe('')
  $<HTMLButtonElement>('#go').click()
  expect($('#out').textContent).toBe('a, button#9')
  expect(m.warnings).toEqual([])
})
