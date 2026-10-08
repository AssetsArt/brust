import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))

test('x-if removes/mounts the element and its subtree; nested host mounts inside', async () => {
  const open = signal(true); const inits: string[] = []
  defineBehavior('i1', () => ({ open }))
  defineBehavior('inner_i1', ({ el }) => { inits.push(el.id); return {} })
  document.body.innerHTML = `<div x-data="i1"><section id="s" x-if="open"><div id="k" x-data="inner_i1"></div></section></div>`
  mount(); await flush()
  expect(document.getElementById('s')).not.toBeNull(); expect(inits).toEqual(['k'])
  open.set(false); await flush()
  expect(document.getElementById('s')).toBeNull()
  open.set(true); await flush()
  expect(document.getElementById('s')).not.toBeNull(); expect(inits).toEqual(['k', 'k'])
})

test('x-if false on first paint: server omitted the element, runtime keeps it out', () => {
  const open = signal(false)
  defineBehavior('i2', () => ({ open }))
  document.body.innerHTML = `<div x-data="i2"><!--x-if--><p id="p" x-if="open" hidden></p></div>`
  mount()
  expect(document.getElementById('p')).toBeNull()
})

test('x-model text input: input event writes the signal, signal writes the value', () => {
  const q = signal('a')
  defineBehavior('m1', () => ({ q }))
  document.body.innerHTML = `<div x-data="m1"><input id="i" x-model="q" value="a"></div>`
  mount()
  const i = document.getElementById('i') as HTMLInputElement
  i.value = 'ab'; i.dispatchEvent(new Event('input', { bubbles: true }))
  expect(q()).toBe('ab')
  q.set('z'); expect(i.value).toBe('z')
})

test('x-model checkbox is boolean; radio group writes value', () => {
  const on = signal(false); const color = signal('red')
  defineBehavior('m2', () => ({ on, color }))
  document.body.innerHTML = `<div x-data="m2"><input id="c" type="checkbox" x-model="on"><input id="r1" type="radio" name="c" value="red" x-model="color" checked><input id="r2" type="radio" name="c" value="blue" x-model="color"></div>`
  mount()
  const c = document.getElementById('c') as HTMLInputElement
  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); expect(on()).toBe(true)
  const r2 = document.getElementById('r2') as HTMLInputElement
  r2.checked = true; r2.dispatchEvent(new Event('change', { bubbles: true })); expect(color()).toBe('blue')
  color.set('red'); expect((document.getElementById('r1') as HTMLInputElement).checked).toBe(true)
})

test('x-model select re-applies the value after options change', async () => {
  const sel = signal('b'); const opts = signal(['a'])
  defineBehavior('m3', () => ({ sel, opts, key: (o: string) => o, val: (o: string) => o }))
  document.body.innerHTML = `<div x-data="m3"><select id="s" x-model="sel"><option x-for="o in opts by key" x-bind-value="val:o" x-text="val:o">a</option></select></div>`
  mount(); await flush()
  opts.set(['a', 'b']); await flush()
  expect((document.getElementById('s') as HTMLSelectElement).value).toBe('b')
})

test('x-model on a non-signal member warns and does nothing', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('m4', () => ({ q: 'plain' }))
  document.body.innerHTML = `<div x-data="m4"><input x-model="q"></div>`
  mount()
  expect(warns.some((w) => w.includes('x-model') && w.includes('signal'))).toBe(true)
  console.warn = orig
})
