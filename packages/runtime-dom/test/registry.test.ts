import { expect, test } from 'bun:test'
import { defineBehavior, setChunkLoader, mount, unmount } from '../src'
import { signal } from '../src/signal'

function html(s: string) { document.body.innerHTML = s; return document.body }

test('mounts one instance per x-data host, seeds props from x-props JSON', () => {
  const seen: unknown[] = []
  defineBehavior('counter_a1', ({ el, props }) => { seen.push({ tag: el.tagName, props: props() }); return {} })
  html(`<div x-data="counter_a1" x-props='{"n":3}'></div><p x-data="counter_a1"></p>`)
  mount()
  expect(seen).toEqual([{ tag: 'DIV', props: { n: 3 } }, { tag: 'P', props: {} }])
  unmount()
})

test('unknown behavior is requested from the chunk loader once, then mounted', async () => {
  const requested: string[] = []
  setChunkLoader(async (name) => { requested.push(name); defineBehavior(name, () => ({ hello: 'yes' })) })
  html(`<div x-data="lazy_b2"></div><div x-data="lazy_b2"></div>`)
  mount()
  await new Promise((r) => setTimeout(r, 0))
  expect(requested).toEqual(['lazy_b2'])
  unmount()
})

test('disposes on removal, remounts on reinsertion', async () => {
  const log: string[] = []
  defineBehavior('life_c3', ({ effect, onCleanup }) => {
    const s = signal(0)
    effect(() => { s(); log.push('run'); return () => log.push('effect-clean') })
    onCleanup(() => log.push('cleanup'))
    return {}
  })
  const body = html(`<div id="h" x-data="life_c3"></div>`)
  mount()
  const host = body.querySelector('#h')!
  host.remove()
  await new Promise((r) => setTimeout(r, 0))   // MutationObserver is async
  expect(log).toEqual(['run', 'effect-clean', 'cleanup'])
  body.appendChild(host)
  await new Promise((r) => setTimeout(r, 0))
  expect(log).toEqual(['run', 'effect-clean', 'cleanup', 'run'])
  unmount()
})

test('a factory that throws does not break mounting of other hosts', () => {
  defineBehavior('boom_d4', () => { throw new Error('boom') })
  defineBehavior('ok_d4', () => ({ ok: true }))
  html(`<div x-data="boom_d4"></div><div id="ok" x-data="ok_d4"></div>`)
  expect(() => mount()).not.toThrow()
  unmount()
})
