import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal, computed } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))

test('x-ref fills ref.current after mount and nulls it on dispose', async () => {
  let r: { current: HTMLElement | null } | null = null
  defineBehavior('r1', ({ ref }) => { r = ref('box'); expect(r.current).toBeNull(); return {} })
  document.body.innerHTML = `<div id="h" x-data="r1"><p id="p" x-ref="box"></p></div>`
  mount()
  expect(r!.current).toBe(document.getElementById('p'))
  document.getElementById('h')!.remove(); await flush()
  expect(r!.current).toBeNull()
})

test('x-props-bind: child props follow parent state, functions pass through, SSR seed untouched until change', () => {
  const count = signal(0); const resets: number[] = []
  defineBehavior('parent_p1', () => ({ count, _p1: computed(() => ({ n: count(), onReset: () => resets.push(count()) })) }))
  defineBehavior('child_p1', ({ props }) => ({ _c1: computed(() => props().n), _h1: (e: Event) => (props().onReset as () => void)() }))
  document.body.innerHTML = `<div x-data="parent_p1"><button id="c" x-data="child_p1" x-props='{"n":0}' x-props-bind="_p1" x-on-click="_h1" x-text="_c1">0</button></div>`
  mount()
  const c = document.getElementById('c') as HTMLButtonElement
  expect(c.textContent).toBe('0')
  count.set(5); expect(c.textContent).toBe('5')
  c.click(); expect(resets).toEqual([5])
})

test('x-props-bind inside x-for passes the item binding', () => {
  const items = signal([{ id: 1, n: 'a' }, { id: 2, n: 'b' }])
  defineBehavior('parent_p2', () => ({ items, key: (i: { id: number }) => i.id, _p1: (item: { n: string }) => ({ name: item.n }) }))
  defineBehavior('row_p2', ({ props }) => ({ _c1: computed(() => props().name) }))
  document.body.innerHTML = `<ul x-data="parent_p2"><li x-for="item in items by key" x-data="row_p2" x-props-bind="_p1:item" x-text="_c1"></li></ul>`
  mount()
  expect(Array.from(document.querySelectorAll('li')).map((l) => l.textContent)).toEqual(['a', 'b'])
})

test('child mounted before its parent chunk arrives waits, then binds', async () => {
  const { setChunkLoader } = await import('../src')
  const count = signal(1)
  defineBehavior('child_p3', ({ props }) => ({ _c1: computed(() => props().n) }))
  setChunkLoader(async (name) => { if (name === 'late_parent_p3') defineBehavior(name, () => ({ _p1: computed(() => ({ n: count() })) })) })
  document.body.innerHTML = `<div x-data="late_parent_p3"><span id="s" x-data="child_p3" x-props='{"n":1}' x-props-bind="_p1" x-text="_c1">1</span></div>`
  mount(); await flush()
  count.set(2); expect(document.getElementById('s')!.textContent).toBe('2')
})

test('x-props-bind with no ancestor instance warns and keeps the JSON seed', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('orphan_p4', ({ props }) => ({ _c1: computed(() => props().n) }))
  document.body.innerHTML = `<span id="s" x-data="orphan_p4" x-props='{"n":7}' x-props-bind="_p1" x-text="_c1">7</span>`
  mount()
  expect(document.getElementById('s')!.textContent).toBe('7')
  expect(warns.some((w) => w.includes('x-props-bind'))).toBe(true)
  console.warn = orig
})
