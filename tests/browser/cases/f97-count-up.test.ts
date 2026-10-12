import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

// happy-dom has no IntersectionObserver: a recording stub the test can fire.
const observed: Element[] = []
let fire: ((e: { isIntersecting: boolean }[]) => void) | null = null
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  constructor(cb: (e: { isIntersecting: boolean }[]) => void) { fire = cb }
  observe(el: Element) { observed.push(el) }
  disconnect() {}
}
;(window as unknown as Record<string, unknown>).IntersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver

test('f97-count-up: a mount effect arms an observer on the ref, and the callback updates the text', async () => {
  const m = await load(build('f97-count-up'))
  expect(m.warnings).toEqual([])
  expect(observed.map((e) => e.id)).toEqual(['v'])
  expect($('#v').textContent).toBe('100')
  fire!([{ isIntersecting: true }])
  expect($('#v').textContent).toBe('42')
})
