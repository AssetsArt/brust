// R34.140-R34.141 (W1c): the collection feature. A root is `x-collection-root`; an item is `data-radix-collection-item` whose
// NEAREST root is that root; data is read from the item's `x-collection-item` member at call time.
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal, computed } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })

type Items = () => Array<Record<string, unknown> & { element: Element; ref: { current: Element } }>

test('items are the elements marked as items under the root, in DOM order, with their data and element', () => {
  let items!: Items
  defineBehavior('c1', ({ items: it }) => { items = it; return {} })
  document.body.innerHTML = `<ul x-data="c1" x-collection-root><li id="a" data-radix-collection-item>a</li><li id="b" data-radix-collection-item>b</li><li id="x">not an item</li></ul>`
  mount()
  const got = items()
  expect(got.map((i) => i.element.id)).toEqual(['a', 'b'])
  expect(got[0]!.ref.current).toBe(document.getElementById('a')!)
})

test('document order is the DOM order: an item inserted in the middle is found there, an item moved changes place', () => {
  let items!: Items
  defineBehavior('c2', ({ items: it }) => { items = it; return {} })
  document.body.innerHTML = `<ul x-data="c2" x-collection-root><li id="a" data-radix-collection-item></li><li id="c" data-radix-collection-item></li></ul>`
  mount()
  const ul = document.querySelector('ul')!
  const b = document.createElement('li'); b.id = 'b'; b.setAttribute('data-radix-collection-item', '')
  ul.insertBefore(b, document.getElementById('c'))
  expect(items().map((i) => i.element.id)).toEqual(['a', 'b', 'c'])
  ul.appendChild(document.getElementById('a')!)
  expect(items().map((i) => i.element.id)).toEqual(['b', 'c', 'a'])
})

test('a nested collection keeps its items to itself (nearest root), and an item that is a root of its own is an item of the outer one', () => {
  let outer!: Items; let inner!: Items
  defineBehavior('c3o', ({ items: it }) => { outer = it; return {} })
  defineBehavior('c3i', ({ items: it }) => { inner = it; return {} })
  document.body.innerHTML = `<div x-data="c3o" x-collection-root><i id="o1" data-radix-collection-item></i>
    <section id="s" data-radix-collection-item><b x-data="c3i" x-collection-root><i id="n1" data-radix-collection-item></i><i id="n2" data-radix-collection-item></i></b></section>
    <i id="o2" data-radix-collection-item></i></div>`
  mount()
  expect(outer().map((i) => i.element.id)).toEqual(['o1', 's', 'o2'])
  expect(inner().map((i) => i.element.id)).toEqual(['n1', 'n2'])
})

test('a host with no root above it has no items; the root is found from a descendant host too', () => {
  let none!: Items; let deep!: Items
  defineBehavior('c4n', ({ items: it }) => { none = it; return {} })
  defineBehavior('c4d', ({ items: it }) => { deep = it; return {} })
  document.body.innerHTML = `<p x-data="c4n"><i data-radix-collection-item></i></p><div x-collection-root><i id="k" data-radix-collection-item></i><u x-data="c4d"></u></div>`
  mount()
  expect(none()).toEqual([])
  expect(deep().map((i) => i.element.id)).toEqual(['k'])
})

test('item data is read from the host member at call time, never stale', () => {
  let items!: Items
  const active = signal(false)
  defineBehavior('c5', ({ items: it }) => { items = it; return { _d1: computed(() => ({ id: 'one', focusable: true, active: active() })) } })
  document.body.innerHTML = `<div x-data="c5" x-collection-root><button id="b1" data-radix-collection-item x-collection-item="_d1"></button></div>`
  mount()
  expect(items()[0]).toMatchObject({ id: 'one', focusable: true, active: false })
  active.set(true)
  expect(items()[0]).toMatchObject({ active: true })
})

test('data cannot override the element or ref the feature adds', () => {
  let items!: Items
  defineBehavior('c6', ({ items: it }) => { items = it; return { _d1: computed(() => ({ element: 'x', ref: 'y', id: 'z' })) } })
  document.body.innerHTML = `<div x-data="c6" x-collection-root><i id="i1" data-radix-collection-item x-collection-item="_d1"></i></div>`
  mount()
  const it = items()[0]!
  expect(it.element).toBe(document.getElementById('i1')!)
  expect(it.ref.current).toBe(document.getElementById('i1')!)
  expect(it.id).toBe('z')
})

test('items inside a React island or inside x-html / x-raw markup are not the collection\'s (inert boundaries)', () => {
  let items!: Items
  defineBehavior('c7', ({ items: it }) => { items = it; return {} })
  document.body.innerHTML = `<ul x-data="c7" x-collection-root><li id="a" data-radix-collection-item></li>`
    + `<brust-island data-id="k"><i id="isl" data-radix-collection-item></i></brust-island>`
    + `<div x-html><b id="cms" data-radix-collection-item></b></div>`
    + `<div x-raw><b id="raw" data-radix-collection-item></b></div>`
    + `<li id="b" data-radix-collection-item></li></ul>`
  mount()
  expect(items().map((i) => i.element.id)).toEqual(['a', 'b'])
})

test('an item that itself holds raw markup is still an item', () => {
  let items!: Items
  defineBehavior('c8', ({ items: it }) => { items = it; return {} })
  document.body.innerHTML = `<ul x-data="c8" x-collection-root><li id="a" data-radix-collection-item x-raw><b data-radix-collection-item id="in"></b></li></ul>`
  mount()
  expect(items().map((i) => i.element.id)).toEqual(['a'])
})
