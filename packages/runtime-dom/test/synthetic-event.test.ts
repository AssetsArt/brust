// F195: a handler written for React calls SyntheticEvent members on the event it is handed. The DOM event has none of them.
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'

beforeEach(() => { unmount(); document.body.innerHTML = '' })

function click(handler: (e: Event) => void, init: EventInit = { bubbles: true, cancelable: true }): void {
  defineBehavior('syn', () => ({ h: handler }))
  document.body.innerHTML = `<div x-data="syn"><button id="b" x-on-click="h"></button></div>`
  mount()
  document.getElementById('b')!.dispatchEvent(new Event('click', init))
}

test('the handler receives React\'s five SyntheticEvent members', () => {
  const seen: Record<string, unknown> = {}
  click((e: any) => {
    seen.stoppedBefore = e.isPropagationStopped()
    e.stopPropagation()
    seen.stoppedAfter = e.isPropagationStopped()
    seen.preventedBefore = e.isDefaultPrevented()
    e.preventDefault()
    seen.preventedAfter = e.isDefaultPrevented()
    seen.persist = e.persist()
    seen.persistent = e.isPersistent()
    seen.native = e.nativeEvent === e
  })
  expect(seen).toEqual({ stoppedBefore: false, stoppedAfter: true, preventedBefore: false, preventedAfter: true, persist: undefined, persistent: true, native: true })
})

test('Event.prototype is untouched (only the event a handler gets is extended)', () => {
  click(() => {})
  for (const k of ['isPropagationStopped', 'isDefaultPrevented', 'persist', 'isPersistent', 'nativeEvent']) expect(k in Event.prototype).toBe(false)
})

test('an event that already has the members keeps them', () => {
  const e = new Event('click', { bubbles: true })
  Object.defineProperty(e, 'isPropagationStopped', { value: () => 'mine' })
  defineBehavior('syn2', () => ({ h: (ev: any) => { expect(ev.isPropagationStopped()).toBe('mine') } }))
  document.body.innerHTML = `<div x-data="syn2"><button id="b" x-on-click="h"></button></div>`
  mount()
  document.getElementById('b')!.dispatchEvent(e)
})
