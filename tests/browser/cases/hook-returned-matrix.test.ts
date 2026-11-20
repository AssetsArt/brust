import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

// F578 D6: the proven cells of the matrix. A function an inlined hook returns, used as an event handler by name (the
// member `m*`, call-site destructuring `d*`), reads one kind of hook-scoped name per hook; each click must show what
// React shows. Cells 7 (a store) and 8 (a context) are refused (crates/brust-compiler/tests/hook_body_shapes.rs).
const CLICKS: [string, string][] = [
  ['#m1', 'lit!'], //       (1) a parameter fed by a literal; (4) hook state + setter
  ['#d1', 'lit2!'],
  ['#m2', 'T!'], //         (2) a parameter fed by a prop
  ['#d2', 'T!'],
  ['#m2d', 'T?'], //        (2) a defaulted parameter fed by a prop
  ['#d2d', 'dflt?'], //     ... and omitted
  ['#m3', '<T>'], //        (3) a prop through the hook's object parameter
  ['#d3', '<T>'],
  ['#m5', 'T#1'], //        (5) a hook derived value
  ['#d5', 'T#1'],
  ['#m6', '[T]'], //        (6) a hook-local arrow
  ['#d6', '[T]'],
  ['#m9', '1'], //          (9) a ref declared in the hook
  ['#d9', '1'],
]

test('hook-returned-matrix: each returned handler shows what React shows', async () => {
  const m = await load(build('hook-returned-matrix'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  for (const [sel, want] of CLICKS) {
    $<HTMLButtonElement>(sel).click()
    expect([sel, $(sel).textContent]).toEqual([sel, want])
  }
  // (10) the same handlers used inside list rows
  const rows = [...document.querySelectorAll<HTMLButtonElement>('li:not([hidden]) .m10')]
  expect(rows.map((b) => b.textContent)).toEqual(['x', 'y'])
  rows[1]!.click()
  expect($('#m1').textContent).toBe('lit!')
  const counted = [...document.querySelectorAll<HTMLButtonElement>('li:not([hidden]) .d10')]
  counted[0]!.click()
  counted[1]!.click()
  expect($('#d9').textContent).toBe('3')
  expect(m.warnings).toEqual([])
})
