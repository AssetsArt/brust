import { expect, test } from 'bun:test'
import { defineIsland, whenIsland, _resetIslands, _setIdle } from '../src/island'
import { mount, unmount } from '../src'

const def = defineIsland
const reset = _resetIslands

test('whenIsland resolves immediately for a defined island', () => {
  _resetIslands()
  const h = () => {}
  defineIsland('team_1', h)
  let got: unknown
  whenIsland('team_1', (f) => { got = f })
  expect(got).toBe(h)
})

test('whenIsland waits for a later defineIsland and fires once', () => {
  _resetIslands()
  let calls = 0
  whenIsland('late_2', () => { calls++ })
  expect(calls).toBe(0)
  defineIsland('late_2', () => {})
  defineIsland('late_2', () => {})   // re-registration does not re-fire old waiters
  expect(calls).toBe(1)
})

test('entries pushed onto globalThis.__brustIslands before the runtime drained are picked up', () => {
  _resetIslands()
  const h = () => {}
  ;(globalThis.__brustIslands ||= []).push(['early_3', h])
  let got: unknown
  whenIsland('early_3', (f) => { got = f })   // drains the queue on first use
  expect(got).toBe(h)
  expect(globalThis.__brustIslands!.length).toBe(0)
})

test('a push after the runtime installed __brustIslandReady is delivered through it', () => {
  _resetIslands()
  let got: unknown
  whenIsland('after_4', (f) => { got = f })
  const h = () => {}
  globalThis.__brustIslands!.push(['after_4', h])
  globalThis.__brustIslandReady?.()
  expect(got).toBe(h)
})

function html(s: string) { document.body.innerHTML = s; return document.body }
/** Run every callback the scheduler handed to the idle primitive. */
function makeIdle() { const q: Array<() => void> = []; _setIdle((cb) => q.push(cb)); return () => { while (q.length) q.shift()!() } }

test('hydrates each island host once when idle, with its x-props, and marks data-hydrated', () => {
  reset(); const flush = makeIdle()
  const seen: Array<[string, unknown]> = []
  def('team_a', (host, props) => { seen.push([host.id, props]) })
  html(`<brust-island id="x" data-id="team_a" x-props='{"n":1}'>server</brust-island><brust-island id="y" data-id="team_a" x-props='{"n":2}'>server</brust-island>`)
  mount()
  expect(seen).toEqual([])            // nothing before idle
  flush()
  expect(seen).toEqual([['x', { n: 1 }], ['y', { n: 2 }]])
  expect(document.querySelectorAll('brust-island[data-hydrated="1"]').length).toBe(2)
  mount(); flush()                    // a second mount pass does not re-hydrate
  expect(seen.length).toBe(2)
  unmount()
})

test('an island whose chunk arrives after mount hydrates when it registers', () => {
  reset(); const flush = makeIdle()
  const seen: string[] = []
  html(`<brust-island data-id="late_b" x-props='{}'>server</brust-island>`)
  mount(); flush()
  expect(seen).toEqual([])
  ;(globalThis.__brustIslands ||= []).push(['late_b', (h) => { seen.push(h.getAttribute('data-id')!) }])
  globalThis.__brustIslandReady?.()
  flush()
  expect(seen).toEqual(['late_b'])
  unmount()
})

test('a host removed before idle is not hydrated', () => {
  reset(); const flush = makeIdle()
  let calls = 0
  def('gone_c', () => { calls++ })
  html(`<div id="wrap"><brust-island data-id="gone_c" x-props='{}'>server</brust-island></div>`)
  mount()
  document.getElementById('wrap')!.remove()
  flush()
  expect(calls).toBe(0)
  unmount()
})

test('bad x-props JSON warns once and hydrates with {}', () => {
  reset(); const flush = makeIdle()
  const warnings: string[] = []; const w = console.warn; console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) }
  let got: unknown
  def('bad_d', (_h, props) => { got = props })
  html(`<brust-island data-id="bad_d" x-props='{oops'>server</brust-island>`)
  mount(); flush()
  console.warn = w
  expect(got).toEqual({})
  expect(warnings.some((m) => m.includes('bad x-props JSON') && m.includes('bad_d'))).toBe(true)
  unmount()
})

test('a hydrate that throws is reported on console.error and the server HTML stays', () => {
  reset(); const flush = makeIdle()
  const errors: string[] = []; const e = console.error; console.error = (...a: unknown[]) => { errors.push(String(a[0])) }
  def('boom_e', () => { throw new Error('nope') })
  html(`<brust-island data-id="boom_e" x-props='{}'>server html</brust-island>`)
  mount(); flush()
  console.error = e
  expect(errors.some((m) => m.includes('hydrate threw: boom_e'))).toBe(true)
  expect(document.querySelector('brust-island')!.textContent).toBe('server html')
  expect(document.querySelector('brust-island')!.hasAttribute('data-hydrated')).toBe(false)
  unmount()
})

test('islands inserted after mount (MutationObserver) are scheduled', async () => {
  reset(); const flush = makeIdle()
  const seen: string[] = []
  def('obs_f', (h) => { seen.push(h.id) })
  html(`<div id="root"></div>`)
  mount()
  document.getElementById('root')!.innerHTML = `<brust-island id="z" data-id="obs_f" x-props='{}'>s</brust-island>`
  await new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)))   // happy-dom delivers observer records in a microtask
  flush()
  expect(seen).toEqual(['z'])
  unmount()
})
