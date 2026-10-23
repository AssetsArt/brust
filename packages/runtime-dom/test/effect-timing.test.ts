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

// F288 (ruling 94404307): a layout effect (`ctx.effect(fn, true)`) re-runs only after every other effect of the same
// change has run (the bindings it may read included), still synchronously; a passive effect keeps today's order.
test('a post effect re-runs after the change has reached every other effect; a passive one keeps today\'s order', async () => {
  const { effect } = await import('../src/signal')
  for (const post of [true, false]) {
    const a = signal(0)
    const b = signal(0)
    const log: string[] = []
    // declared first, so it is notified first: it reads `b`, which the effect below derives from `a`
    const stop1 = effect(() => { a(); log.push(`saw b=${b()}`) }, post)
    const stop2 = effect(() => { b.set(a() * 10) })
    a.set(1)
    // post: one re-run, after `b` is 10 (React's commit, then layout effects). Passive: it ran first and saw the stale
    // `b`, then again for `b` (today's timing, unchanged).
    expect(log).toEqual(post ? ['saw b=0', 'saw b=10'] : ['saw b=0', 'saw b=0', 'saw b=10'])
    stop1(); stop2()
  }
})

test('x-pref: the ref a caller passes lands on a nested host, in the caller\'s ref cell (not the host\'s own)', () => {
  const seen: string[] = []
  defineBehavior('t_pref_parent', ({ effect, ref }) => {
    const r = ref('_rf1')
    effect(() => { seen.push(`parent:${r.current?.id}`) })
    return {}
  })
  defineBehavior('t_pref_child', ({ effect, ref }) => {
    const r = ref('_rf1')
    effect(() => { seen.push(`child:${r.current?.id ?? 'null'}`) })
    return {}
  })
  document.body.innerHTML = `<div x-data="t_pref_parent"><p id="kid" x-data="t_pref_child" x-pref="_rf1">k</p></div>`
  mount()
  expect(seen).toContain('parent:kid')
  expect(seen).toContain('child:null')
})
