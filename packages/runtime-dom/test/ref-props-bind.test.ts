import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, setChunkLoader, unmount } from '../src'
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

// Review round 1: the link must target the nearest ancestor HOST, mounted or not.
for (const order of [['gp', 'mid'], ['mid', 'gp']] as const) {
  test(`three levels, chunks arrive ${order.join(' then ')}: leaf binds to mid, never gp`, async () => {
    const factories: Record<string, () => Record<string, unknown>> = {
      gp: () => ({ _p: computed(() => ({ v: 'OUTER' })) }),
      mid: () => ({ _p: computed(() => ({ v: 'MID' })) }),
    }
    const tag = order.join('')
    defineBehavior(`leaf_${tag}`, ({ props }) => ({ _c: computed(() => props().v) }))
    const pending = new Map<string, () => void>()
    setChunkLoader(async (name) => { const k = name.split('_')[0]!; pending.set(k, () => defineBehavior(name, factories[k]!)) })
    document.body.innerHTML = `<div x-data="gp_${tag}"><div x-data="mid_${tag}"><i id="l" x-data="leaf_${tag}" x-props='{"v":"seed"}' x-props-bind="_p" x-text="_c">seed</i></div></div>`
    mount(); await flush()
    for (const k of order) { pending.get(k)!(); await flush() }
    expect(document.getElementById('l')!.textContent).toBe('MID')
  })
}

test('x-props-bind to a non-object warns and keeps the previous props', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  const v = signal<unknown>({ n: 1 })
  defineBehavior('par_np', () => ({ _p: computed(() => v()) }))
  defineBehavior('kid_np', ({ props }) => ({ _c: computed(() => props().n) }))
  document.body.innerHTML = `<div x-data="par_np"><b id="b" x-data="kid_np" x-props-bind="_p" x-text="_c">1</b></div>`
  mount()
  v.set(null)
  console.warn = orig
  expect(document.getElementById('b')!.textContent).toBe('1')
  expect(warns.some((w) => w.includes('not an object'))).toBe(true)
})

test('unmount(subtree) leaves the observer running for the rest of the page', async () => {
  defineBehavior('u_one', () => ({}))
  const seen: string[] = []
  defineBehavior('u_two', ({ el }) => { seen.push(el.id); return {} })
  document.body.innerHTML = `<div id="one"><i x-data="u_one"></i></div><div id="two"></div>`
  mount()
  unmount(document.getElementById('one')!)
  document.getElementById('two')!.innerHTML = `<i id="late" x-data="u_two"></i>`
  await flush()
  expect(seen).toEqual(['late'])
})
