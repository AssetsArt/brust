import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const texts = () => Array.from(document.querySelectorAll('li')).map((l) => l.textContent)

test('renders rows from the server, reconciles by key: insert, remove, reorder keep DOM identity', () => {
  const items = signal([{ id: 1, n: 'a' }, { id: 2, n: 'b' }])
  defineBehavior('f1', () => ({ items, key: (i: { id: number }) => i.id, name: (i: { n: string }) => i.n }))
  document.body.innerHTML = `<ul x-data="f1"><li x-for="item in items by key" x-text="name:item">a</li><li x-for="item in items by key" x-text="name:item">b</li></ul>`
  mount()
  expect(texts()).toEqual(['a', 'b'])
  const first = document.querySelector('li')!
  items.set([{ id: 2, n: 'b' }, { id: 1, n: 'a' }, { id: 3, n: 'c' }])
  expect(texts()).toEqual(['b', 'a', 'c'])
  expect(document.querySelectorAll("li")[1]).toBe(first)        // server row adopted, then moved not recreated
  items.set([{ id: 3, n: 'c' }])
  expect(texts()).toEqual(['c'])
})

test('index binding and item-scoped handler', () => {
  const picks: unknown[] = []
  const items = signal(['x', 'y'])
  defineBehavior('f2', () => ({ items, key: (s: string) => s, label: (s: string, i: number) => `${i}:${s}`, pick: (s: string, i: number, e: Event) => picks.push([s, i, e.type]) }))
  document.body.innerHTML = `<ul x-data="f2"><li x-for="item, index in items by key" x-text="label:item,index" x-on-click="pick:item,index"></li></ul>`
  mount()
  expect(texts()).toEqual(['0:x', '1:y'])
  ;(document.querySelectorAll('li')[1] as HTMLElement).click()
  expect(picks).toEqual([['y', 1, 'click']])
})

test('duplicate keys warn once and fall back to index identity (no infinite loop, no dropped rows)', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  const items = signal([{ id: 1 }, { id: 1 }, { id: 2 }])
  defineBehavior('f3', () => ({ items, key: (i: { id: number }) => i.id, show: (i: { id: number }) => String(i.id) }))
  document.body.innerHTML = `<ul x-data="f3"><li x-for="item in items by key" x-text="show:item"></li></ul>`
  mount()
  expect(texts()).toEqual(['1', '1', '2'])
  items.set([{ id: 1 }, { id: 1 }])
  expect(texts()).toEqual(['1', '1'])
  expect(warns.filter((w) => w.includes('duplicate key')).length).toBe(1)
  console.warn = orig
})

test('server rendered zero rows: the x-for template is still found via the comment marker', () => {
  const items = signal<string[]>([])
  defineBehavior('f4', () => ({ items, key: (s: string) => s, t: (s: string) => s }))
  document.body.innerHTML = `<ul x-data="f4"><!--x-for--><li x-for="item in items by key" x-text="t:item" hidden></li></ul>`
  mount()
  expect(texts()).toEqual([])
  items.set(['a']); expect(texts()).toEqual(['a'])
})

test('a changed item under the same key is re-rendered', () => {
  const items = signal([{ id: 1, n: 'a' }])
  defineBehavior('f5', () => ({ items, key: (i: { id: number }) => i.id, name: (i: { n: string }) => i.n }))
  document.body.innerHTML = `<ul x-data="f5"><li x-for="item in items by key" x-text="name:item">a</li></ul>`
  mount()
  items.set([{ id: 1, n: 'z' }])
  expect(texts()).toEqual(['z'])
})

test('a moved row refreshes its index binding without being recreated', () => {
  const items = signal(['x', 'y'])
  defineBehavior('f6', () => ({ items, key: (s: string) => s, label: (s: string, i: number) => `${i}:${s}` }))
  document.body.innerHTML = `<ul x-data="f6"><li x-for="item, index in items by key" x-text="label:item,index"></li></ul>`
  mount()
  const x = document.querySelector('li')!
  items.set(['y', 'x'])
  expect(texts()).toEqual(['0:y', '1:x'])
  expect(document.querySelectorAll('li')[1]).toBe(x)
})
