// R34.105 / 2b-hooks: a library's layout-style or insertion effect (`useLayoutEffect`, `useInsertionEffect`) is lowered
// onto the component's native effect. That is sound only if a native effect never runs later than React's layout
// effect would: after the DOM it reads is committed, in the same task, before the browser can paint. These pin it.
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })

test('the first run of an effect reads the committed DOM, synchronously within mount()', () => {
  const seen: string[] = []
  defineBehavior('t_first', ({ effect, ref }) => {
    const box = ref('box')
    effect(() => { seen.push(`${box.current?.id}:${box.current?.textContent}`) })
    return {}
  })
  document.body.innerHTML = `<div x-data="t_first"><p id="p" x-ref="box">rendered</p></div>`
  mount()
  // No await: the effect has already run, and found the element the server (or the bind pass) put there.
  expect(seen).toEqual(['p:rendered'])
})

test('a re-run reads the DOM the same write just committed (text binding first, effect after), with no await', () => {
  const n = signal(0)
  const seen: string[] = []
  defineBehavior('t_rerun', ({ effect, ref }) => {
    const out = ref('out')
    effect(() => { n(); seen.push(out.current?.textContent ?? '') })
    return { n }
  })
  document.body.innerHTML = `<div x-data="t_rerun"><span x-ref="out" x-text="n">0</span></div>`
  mount()
  n.set(1)
  n.set(2)
  // Each write re-ran the effect before `set` returned, and the effect saw the text that same write committed.
  expect(seen).toEqual(['0', '1', '2'])
})

test('effects run in declaration order (a bookkeeping effect declared first is seen by the one after it)', () => {
  const order: string[] = []
  const n = signal(0)
  let box = 0
  defineBehavior('t_order', ({ effect }) => {
    effect(() => { box = n() })            // the insertion-style effect: records the latest callback
    effect(() => { order.push(`value-effect saw ${box}`); n() })
    return { n }
  })
  document.body.innerHTML = `<div x-data="t_order"></div>`
  mount()
  n.set(7)
  expect(order).toEqual(['value-effect saw 0', 'value-effect saw 7'])
})
