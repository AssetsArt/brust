// F434: a <select multiple> binds to an array. The picks the server painted (`selected` options) survive mount, a change
// writes the array of picked values, and a new array picks the matching options.
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))
const OPTS = `<option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option>`
// `option.selected`, not `selectedOptions`: happy-dom's list is stale after a property write
const picked = (s: HTMLSelectElement) => Array.from(s.options).filter((o) => o.selected).map((o) => o.value)

test('x-model on a multiple select keeps the server picks, writes an array on change and follows the signal', async () => {
  const v = signal<string[]>(['a', 'c'])
  defineBehavior('ms1', () => ({ v }))
  document.body.innerHTML = `<div x-data="ms1"><select id="s" multiple x-model="v">${OPTS}</select></div>`
  mount(); await flush()
  const s = document.getElementById('s') as HTMLSelectElement
  expect(picked(s)).toEqual(['a', 'c'])
  s.options[0]!.selected = false; s.options[1]!.selected = true
  s.dispatchEvent(new Event('change', { bubbles: true }))
  expect(v()).toEqual(['b', 'c'])
  v.set(['a']); await flush()
  expect(picked(s)).toEqual(['a'])
  v.set([]); await flush()
  expect(picked(s)).toEqual([])
})

test('x-bind-value on a multiple select picks the options of an array, a scalar is one pick, null leaves them', async () => {
  const v = signal<unknown>(['b'])
  defineBehavior('ms2', () => ({ v }))
  document.body.innerHTML = `<div x-data="ms2"><select id="s" multiple x-bind-value="v">${OPTS}</select></div>`
  mount(); await flush()
  const s = document.getElementById('s') as HTMLSelectElement
  expect(picked(s)).toEqual(['b'])
  v.set(['a', 'c']); await flush()
  expect(picked(s)).toEqual(['a', 'c'])
  v.set('b'); await flush()
  expect(picked(s)).toEqual(['b'])
  v.set(null); await flush()
  expect(picked(s)).toEqual(['b'])
})

test('a single select is unchanged: the value is one string', async () => {
  const v = signal('b')
  defineBehavior('ms3', () => ({ v }))
  document.body.innerHTML = `<div x-data="ms3"><select id="s" x-model="v"><option value="a">A</option><option value="b">B</option></select></div>`
  mount(); await flush()
  const s = document.getElementById('s') as HTMLSelectElement
  expect(s.value).toBe('b')
  s.value = 'a'; s.dispatchEvent(new Event('change', { bubbles: true }))
  expect(v()).toBe('a')
})
