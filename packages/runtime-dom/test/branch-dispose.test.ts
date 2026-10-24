// F415/F416: an `x-if` branch and an `x-for` row own what they bound. Removing one stops its effects and runs its
// cleanups (an `x-ref` lets go of the node, as React sets a removed host's ref to null); a row created after its branch
// bound goes with the branch too.
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })

/** A member whose every read is counted: one read per run of an effect bound to it. */
const counted = () => {
  const label = signal('a'); const n = { reads: 0 }
  return { label, n, member: { get txt() { n.reads++; return label() } } }
}

test('F415: a removed x-if branch stops its effects, after 20 toggles one change runs only the live branch', () => {
  const open = signal(true); const { label, n, member } = counted()
  defineBehavior('bd1', () => ({ open, get txt() { return member.txt } }))
  document.body.innerHTML = `<div x-data="bd1"><p x-if="open" x-text="txt">a</p></div>`
  mount()
  for (let i = 0; i < 20; i++) { open.set(false); open.set(true) }
  n.reads = 0; label.set('b')
  expect(n.reads).toBe(1)
  expect(document.querySelector('p')!.textContent).toBe('b')
  open.set(false)
  n.reads = 0; label.set('c')
  expect(n.reads).toBe(0)
})

test('F416: an x-ref in a branch is null once the branch is removed, and the new node when it is back', () => {
  const open = signal(true); let box: { current: Element | null } | undefined
  defineBehavior('bd2', ({ ref }) => { box = ref('box'); return { open } })
  document.body.innerHTML = `<div x-data="bd2"><p x-if="open" x-ref="box">a</p></div>`
  mount()
  const first = document.querySelector('p')
  expect(box!.current).toBe(first)
  open.set(false)
  expect(box!.current).toBeNull()
  open.set(true)
  expect(box!.current).toBe(document.querySelector('p'))
  expect(box!.current).not.toBe(first)
})

test('F415: a removed x-for row stops its effects', () => {
  const items = signal([{ id: 1 }]); const { label, n, member } = counted()
  defineBehavior('bd3', () => ({ items, key: (i: { id: number }) => i.id, get txt() { return member.txt } }))
  document.body.innerHTML = `<ul x-data="bd3"><li x-for="item in items by key" x-text="txt">a</li></ul>`
  mount()
  for (let i = 2; i < 22; i++) items.set([{ id: i }])
  n.reads = 0; label.set('b')
  expect(document.querySelectorAll('li').length).toBe(1)
  expect(n.reads).toBe(1)
})

test('F415: a row created after its branch bound, and a nested branch, go with the branch', () => {
  const open = signal(true); const inner = signal(true); const items = signal([{ id: 1 }]); const { label, n, member } = counted()
  defineBehavior('bd4', () => ({ open, inner, items, key: (i: { id: number }) => i.id, get txt() { return member.txt } }))
  document.body.innerHTML = `<div x-data="bd4"><section x-if="open"><i x-for="item in items by key" x-text="txt">a</i><b x-if="inner" x-text="txt">a</b></section></div>`
  mount()
  items.set([{ id: 1 }, { id: 2 }])
  n.reads = 0; label.set('b')
  expect(n.reads).toBe(3)
  open.set(false)
  n.reads = 0; label.set('c')
  expect(n.reads).toBe(0)
})

test('F416: unmounting the host lets go of a live branch\'s x-ref', () => {
  let box: { current: Element | null } | undefined
  defineBehavior('bd5', ({ ref }) => { box = ref('box'); return { open: true } })
  document.body.innerHTML = `<div x-data="bd5"><p x-if="open" x-ref="box">a</p></div>`
  mount()
  expect(box!.current).not.toBeNull()
  unmount()
  expect(box!.current).toBeNull()
})
