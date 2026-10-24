import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal, computed } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })

// F329b: x-prop-<attribute>="<prop key>" binds an attribute to a prop of the instance it sits in.
test('x-prop-*: a linked prop follows the parent; the key is the value (aria-checked, tabIndex); booleans print as strings on aria-*', () => {
  const on = signal(false); const tab = signal(0)
  defineBehavior('prop_parent', () => ({ on, tab, _p1: computed(() => ({ 'aria-checked': on(), tabIndex: tab() })) }))
  defineBehavior('prop_child', () => ({}))
  document.body.innerHTML = `<div x-data="prop_parent"><div x-data="prop_child" x-props='{"aria-checked":false,"tabIndex":0}' x-props-bind="_p1"><button id="b" aria-checked="false" tabindex="0" x-prop-aria-checked="aria-checked" x-prop-tabindex="tabIndex"></button></div></div>`
  mount()
  const b = document.getElementById('b')!
  expect(b.getAttribute('aria-checked')).toBe('false'); expect(b.getAttribute('tabindex')).toBe('0')
  on.set(true); tab.set(-1)
  expect(b.getAttribute('aria-checked')).toBe('true'); expect(b.getAttribute('tabindex')).toBe('-1')
})

test('x-prop-*: null / undefined remove the attribute, a string is written, a boolean on a plain attribute is omitted', () => {
  const v = signal<unknown>('radio')
  defineBehavior('prop_parent2', () => ({ _p1: computed(() => ({ role: v() })) }))
  defineBehavior('prop_child2', () => ({}))
  document.body.innerHTML = `<div x-data="prop_parent2"><div x-data="prop_child2" x-props='{"role":"radio"}' x-props-bind="_p1"><i id="i" role="radio" x-prop-role="role"></i></div></div>`
  mount()
  const i = document.getElementById('i')!
  expect(i.getAttribute('role')).toBe('radio')
  v.set(null); expect(i.hasAttribute('role')).toBe(false)
  v.set('tab'); expect(i.getAttribute('role')).toBe('tab')
  v.set(true); expect(i.hasAttribute('role')).toBe(false)
  v.set(undefined); expect(i.hasAttribute('role')).toBe(false)
})

test('x-prop-* refuses what the server print never binds: handlers, srcdoc, x-*, class, style, value, URLs', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('prop_child3', () => ({}))
  document.body.innerHTML = `<div id="h" x-data="prop_child3" x-props='{"a":"javascript:alert(1)","b":"x"}'><a id="a" href="/ok" x-prop-href="a" x-prop-onclick="a" x-prop-srcdoc="b" x-prop-class="b" x-prop-style="b" x-prop-value="b" x-prop-x-text="b"></a></div>`
  mount()
  const a = document.getElementById('a')!
  expect(a.getAttribute('href')).toBe('/ok')
  expect(a.hasAttribute('onclick')).toBe(false); expect(a.hasAttribute('srcdoc')).toBe(false); expect(a.getAttribute('style')).toBeNull()
  expect(warns.filter((w) => w.includes('x-prop-')).length).toBeGreaterThanOrEqual(7)
  console.warn = orig
})

test('x-prop-*: every step of true/false/null/string/number on aria-* and role, and a missing key removes the attribute', () => {
  const v = signal<unknown>('a')
  defineBehavior('prop_parent5', () => ({ _p1: computed(() => ({ 'aria-checked': v(), role: v() })) }))
  defineBehavior('prop_child5', () => ({}))
  document.body.innerHTML = `<div x-data="prop_parent5"><div x-data="prop_child5" x-props='{}' x-props-bind="_p1"><i id="i" x-prop-aria-checked="aria-checked" x-prop-role="role" x-prop-title="nope"></i></div></div>`
  mount()
  const i = document.getElementById('i')!
  const steps: Array<[unknown, string | null, string | null]> = [['a', 'a', 'a'], [true, 'true', null], [false, 'false', null], [null, null, null], [0, '0', '0'], [undefined, null, null], ['', '', '']]
  for (const [val, aria, role] of steps) { v.set(val); expect([i.getAttribute('aria-checked'), i.getAttribute('role')]).toEqual([aria, role]) }
  expect(i.hasAttribute('title')).toBe(false)
})

// F369c: x-prop-on-<event>="<prop key>" calls the instance's prop at event time (the CURRENT value), with a React-shaped event.
test('x-prop-on-*: the handler prop is read when the event fires, so a swapped prop is the one that runs', () => {
  const calls: string[] = []
  const fn = signal<unknown>((e: Event) => { calls.push(`a:${(e as unknown as { isPropagationStopped: () => boolean }).isPropagationStopped()}`) })
  defineBehavior('prop_parent4', () => ({ _p1: computed(() => ({ onMouseDown: fn() })) }))
  defineBehavior('prop_child4', () => ({}))
  document.body.innerHTML = `<div x-data="prop_parent4"><div x-data="prop_child4" x-props-bind="_p1"><button id="b" x-prop-on-mousedown="onMouseDown"></button></div></div>`
  mount()
  const b = document.getElementById('b')!
  b.dispatchEvent(new Event('mousedown', { bubbles: true }))
  expect(calls).toEqual(['a:false'])
  fn.set(() => calls.push('b'))
  b.dispatchEvent(new Event('mousedown', { bubbles: true }))
  expect(calls).toEqual(['a:false', 'b'])
  fn.set(undefined) // not a function: nothing runs, nothing throws
  b.dispatchEvent(new Event('mousedown', { bubbles: true }))
  expect(calls.length).toBe(2)
})

test('x-prop-on-*: an event name outside [a-z0-9]+ is refused and binds nothing', () => {
  let n = 0
  defineBehavior('prop_parent5', () => ({ _p1: computed(() => ({ h: () => { n++ } })) }))
  defineBehavior('prop_child5', () => ({}))
  document.body.innerHTML = `<div x-data="prop_parent5"><div x-data="prop_child5" x-props-bind="_p1"><button id="b" x-prop-on-click-x="h" x-prop-on-="h"></button></div></div>`
  mount()
  document.getElementById('b')!.dispatchEvent(new Event('click-x', { bubbles: true }))
  expect(n).toBe(0)
})
