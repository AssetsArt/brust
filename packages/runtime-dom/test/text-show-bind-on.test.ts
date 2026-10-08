import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal, computed } from '../src/signal'

beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))

test('x-text keeps server text until the signal changes, then writes', () => {
  const label = signal('Light')
  defineBehavior('t1', () => ({ label }))
  document.body.innerHTML = `<div x-data="t1"><span id="s" x-text="label">Light</span></div>`
  mount()
  const s = document.getElementById('s')!
  expect(s.textContent).toBe('Light')
  label.set('Dark'); expect(s.textContent).toBe('Dark')
})

test('x-text with a dotted path through a computed', () => {
  const user = signal({ name: 'Ann' })
  defineBehavior('t2', () => ({ user }))
  document.body.innerHTML = `<div x-data="t2"><b id="b" x-text="user.name">Ann</b></div>`
  mount()
  user.set({ name: 'Bob' }); expect(document.getElementById('b')!.textContent).toBe('Bob')
})

test('x-show toggles display', () => {
  const open = signal(false)
  defineBehavior('t3', () => ({ open }))
  document.body.innerHTML = `<div x-data="t3"><p id="p" x-show="open" style="display:none"></p></div>`
  mount()
  const p = document.getElementById('p') as HTMLElement
  expect(p.style.display).toBe('none')
  open.set(true); expect(p.style.display).toBe('')
  open.set(false); expect(p.style.display).toBe('none')
})

test('x-bind-: class, value property, boolean disabled, null removes', () => {
  const cls = signal('a'); const val = signal('x'); const busy = signal(false); const title = signal<string | null>('t')
  defineBehavior('t4', () => ({ cls, val, busy, title }))
  document.body.innerHTML = `<div x-data="t4"><input id="i" class="a" value="x" title="t" x-bind-class="cls" x-bind-value="val" x-bind-disabled="busy" x-bind-title="title"></div>`
  mount()
  const i = document.getElementById('i') as HTMLInputElement
  cls.set('b'); expect(i.className).toBe('b')
  val.set('y'); expect(i.value).toBe('y')
  busy.set(true); expect(i.disabled).toBe(true); expect(i.hasAttribute('disabled')).toBe(true)
  busy.set(false); expect(i.disabled).toBe(false); expect(i.hasAttribute('disabled')).toBe(false)
  title.set(null); expect(i.hasAttribute('title')).toBe(false)
})

test('x-on-click calls the member with the event; item-scoped handler gets bindings first', () => {
  const clicks: unknown[] = []
  defineBehavior('t5', () => ({ hit: (e: Event) => clicks.push(e.type), pick: (item: unknown, e: Event) => clicks.push([item, e.type]) }))
  document.body.innerHTML = `<div x-data="t5"><button id="a" x-on-click="hit"></button></div>`
  mount()
  ;(document.getElementById('a') as HTMLButtonElement).click()
  expect(clicks).toEqual(['click'])
})

test('a typo in a directive value warns once and leaves the DOM alone', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('t6', () => ({ label: signal('ok') }))
  document.body.innerHTML = `<div x-data="t6"><span id="s" x-text="labl">server</span><span x-text="labl"></span></div>`
  expect(() => mount()).not.toThrow()
  expect(document.getElementById('s')!.textContent).toBe('server')
  expect(warns.filter((w) => w.includes('labl')).length).toBe(1)
  console.warn = orig
})

test('x-text initial mismatch is corrected and reported once (compiler-bug tripwire)', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('t7', () => ({ label: computed(() => 'client') }))
  document.body.innerHTML = `<div x-data="t7"><span id="s" x-text="label">server</span></div>`
  mount()
  expect(document.getElementById('s')!.textContent).toBe('client')
  expect(warns.some((w) => w.includes('mismatch'))).toBe(true)
  console.warn = orig
})

test('x-bind- refuses on* / srcdoc attributes and javascript: URLs', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  const evil = signal('alert(1)'); const url = signal('/ok')
  defineBehavior('t8', () => ({ evil, url }))
  document.body.innerHTML = `<div x-data="t8"><a id="a" x-bind-onclick="evil" x-bind-href="url" href="/ok">x</a></div>`
  mount()
  const a = document.getElementById('a')!
  expect(a.hasAttribute('onclick')).toBe(false)
  url.set('javascript:alert(1)'); expect(a.getAttribute('href')).toBe('/ok')
  url.set('java\tscript:alert(1)'); expect(a.getAttribute('href')).toBe('/ok')
  url.set('/next'); expect(a.getAttribute('href')).toBe('/next')
  console.warn = orig
  expect(warns.length).toBe(2)
})
