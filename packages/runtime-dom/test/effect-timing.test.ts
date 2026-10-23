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

// F288 (ruling 94404307, amended on Mellow F1): a re-run follows React's commit order: every binding of the change, then
// compiled layout effects (`ctx.effect(fn, true)`), then compiled passive effects (`ctx.effect(fn)`), each in declaration
// order; first runs are unchanged (F97).
test('core tiers: a later tier re-runs after the change has reached every effect of an earlier one', async () => {
  const { effect } = await import('../src/signal')
  for (const tier of [1, 2, 0]) {
    const a = signal(0)
    const b = signal(0)
    const log: string[] = []
    // declared first, so it is notified first: it reads `b`, which the binding-tier effect below derives from `a`
    const stop1 = effect(() => { a(); log.push(`saw b=${b()}`) }, tier)
    const stop2 = effect(() => { b.set(a() * 10) })
    a.set(1)
    // tier 1/2: one re-run, after `b` is 10. Tier 0 (a binding): notify order, as before.
    expect(log).toEqual(tier ? ['saw b=0', 'saw b=10'] : ['saw b=0', 'saw b=0', 'saw b=10'])
    stop1(); stop2()
  }
})

test('a layout effect that writes runs before a passive effect that reads it (Mellow le.tsx), after the bindings', () => {
  const n = signal(0)
  const seen: string[] = []
  defineBehavior('t_le', ({ effect, ref }) => {
    const latest = ref<HTMLElement>('latest')
    const out = ref('out')
    // declared passive FIRST: React still runs the layout effect of the same commit before it
    effect(() => { n(); seen.push(`passive:${(latest as unknown as { current: string }).current}:${out.current?.textContent}`) })
    effect(() => { n(); (latest as unknown as { current: string }).current = `v${n()}` }, true)
    return { n }
  })
  document.body.innerHTML = `<div x-data="t_le"><span x-ref="out" x-text="n">0</span></div>`
  mount()
  n.set(1)
  // first run: declaration order (F97), so passive saw the ref before the layout effect wrote it; re-run: React's order,
  // and the binding (x-text) already committed `1`
  expect(seen).toEqual(['passive:null:0', 'passive:v1:1'])
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
