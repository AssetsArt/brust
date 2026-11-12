// F533: a navigation sets the keys the destination's loader wrote (`~w` in its store tag) on live stores; every other key
// keeps its client value, a store not live yet seeds from the tag as on a full load. The swap applies them after the old
// level is disposed and before the new one mounts (mount.ts's flush), so no old effect sees the new value and no new
// effect runs with the old one. The served Chromium check is tests/server/spa-nav.chromium.test.ts.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { boot } from '../src/nav/nav'
import { signal } from '../src/signal'
import { defineStore } from '../src/store/define-store'
import { type StoreInstanceRecord, _resetStores, applyWrittenKeys, ssrSnapshotOf } from '../src/store/registry'

const L = (id: string, hash: string, inner: string) => `<!--brust-l:${id}:${hash}-->${inner}<!--/brust-l:${id}-->`
const tagHtml = (name: string, state: object) => `<script type="application/json" data-brust-store="${name}">${JSON.stringify(state)}</script>`
const nav = '<script type="module" src="/_brust/client/nav-1.js" data-brust-nav data-brust-build="b1" data-brust-root="R:1"></script>'
const page = (inner: string, tags: string) => `<!doctype html><html><head></head><body><header id="h">site</header>${L('P', inner, inner)}${nav}${tags}</body></html>`
function show(html: string): void {
  const d = new DOMParser().parseFromString(html, 'text/html')
  document.head.replaceChildren(...Array.from(d.head.childNodes))
  document.body.replaceChildren(...Array.from(d.body.childNodes))
}
function tag(name: string, state: object): Element {
  const el = document.createElement('script')
  el.setAttribute('type', 'application/json')
  el.setAttribute('data-brust-store', name)
  el.textContent = JSON.stringify(state)
  document.body.append(el)
  return el
}
const ssr = (h: object) => (h as Record<symbol, () => Record<string, unknown>>)[Symbol.for('brust.ssrSnapshot')]!()
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }

let n = 0
const fresh = () => `s${++n}` // a store name per test: defineStore handles outlive _resetStores

let stop = () => {}
const realFetch = globalThis.fetch
beforeEach(() => {
  unmount()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  ;(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('http://localhost/a')
  history.replaceState(null, '', '/a')
})
afterEach(() => {
  stop()
  globalThis.fetch = realFetch
  _resetStores()
})

// ---- the registry half ----------------------------------------------------------------------------------------------

test('a written key is set on a live store; an unwritten key keeps its client value', () => {
  const name = fresh()
  const s = defineStore(name, () => ({ id: signal('1'), count: signal(0) }))
  tag(name, { id: '1', count: 0 })
  s.count.set(5)
  applyWrittenKeys([tag(name, { id: '2', count: 0, '~w': ['id'] })])
  expect(s.id()).toBe('2')
  expect(s.count()).toBe(5)
  expect(s.snapshot()).toEqual({ id: '2', count: 5 })
})

test('a written key equal to the client value, an unknown key and a key absent from the tag change nothing', () => {
  const name = fresh()
  const s = defineStore(name, () => ({ id: signal('1'), count: signal(0) }))
  tag(name, { id: '1', count: 0 })
  s.count.set(5)
  applyWrittenKeys([tag(name, { id: '1', '~w': ['id', 'count', 'nope'] })])
  expect(s.snapshot()).toEqual({ id: '1', count: 5 })
})

test('a tag without ~w (a loader that wrote nothing) leaves a live store as it is', () => {
  const name = fresh()
  const s = defineStore(name, () => ({ id: signal('1') }))
  tag(name, { id: '1' })
  s.id.set('client')
  applyWrittenKeys([tag(name, { id: '2' })])
  expect(s.id()).toBe('client')
})

test('a store not live yet is not created by the apply; its first access seeds from the tag, ~w stripped', () => {
  const name = fresh()
  const el = tag(name, { id: '2', count: 3, '~w': ['id'] })
  applyWrittenKeys([el])
  const reg = (globalThis as Record<symbol, Record<string, unknown> | undefined>)[Symbol.for('brust.stores')]
  expect(reg?.[name]).toBeUndefined()
  const s = defineStore(name, () => ({ id: signal('0'), count: signal(0) }))
  expect(s.snapshot()).toEqual({ id: '2', count: 3 })
})

test('~w never reaches the island hydration snapshot (ssrSnapshotOf / useStore server snapshot)', () => {
  const name = fresh()
  const s = defineStore(name, () => ({ id: signal('1'), count: signal(0) }))
  const first = tag(name, { id: '1', count: 0, '~w': ['id'] })
  expect(ssr(s)).toEqual({ id: '1', count: 0 })
  s.count.set(5)
  const next = tag(name, { id: '2', count: 0, '~w': ['id'] })
  first.remove() // the swap removes the old tail
  applyWrittenKeys([next])
  expect(ssr(s)).toEqual({ id: '2', count: 0 }) // the new page's server truth, which the island markup was rendered from
  next.remove()
  expect(ssr(s)).toEqual({ id: '2', count: 0 }) // no tag left: rec.ssr carries the written key
})

test('F534: an object-valued written key is the SAME object in the island server snapshot and on the live signal', () => {
  const name = fresh()
  const s = defineStore(name, () => ({ obj: signal<{ v: number }>({ v: 0 }), list: signal<number[]>([]), n: signal(0) }))
  const first = tag(name, { obj: { v: 1 }, list: [1], n: 0 })
  expect(s.obj().v).toBe(1)
  s.n.set(5)
  const next = tag(name, { obj: { v: 2 }, list: [2], n: 0, '~w': ['obj', 'list'] })
  first.remove()
  applyWrittenKeys([next])
  // as the swap does: the tag applied is the one nav fetched, the tag left in the page the fetched document's own copy
  next.replaceWith(next.cloneNode(true))
  const snap = ssr(s)
  expect(snap.obj).toBe(s.obj()) // one parse: identity, not just JSON equality
  expect(snap.list).toBe(s.list())
  expect(snap).toEqual({ obj: { v: 2 }, list: [2], n: 0 }) // unwritten n: the tag's server truth, as before
  expect(ssr(s)).toBe(snap) // identity-stable for React
  expect(s.n()).toBe(5)
})

test('F534: the identity holds across runtime copies (an island chunk reads the snapshot through its own registry)', async () => {
  const name = fresh()
  const s = defineStore(name, () => ({ obj: signal<{ v: number }>({ v: 0 }) }))
  const first = tag(name, { obj: { v: 1 } })
  s.obj()
  const next = tag(name, { obj: { v: 2 }, '~w': ['obj'] })
  first.remove()
  applyWrittenKeys([next]) // the page's copy (nav calls it through globalThis)
  const other = (await import('../src/store/registry.ts?f534-copy')) as typeof import('../src/store/registry')
  expect(other.ssrSnapshotOf).not.toBe(ssrSnapshotOf) // a distinct module instance
  const rec = (globalThis as unknown as Record<symbol, Record<string, StoreInstanceRecord>>)[Symbol.for('brust.stores')]![name]!
  expect(other.ssrSnapshotOf(name, rec)!.obj).toBe(s.obj())
})

test('the built-in navigation store is untouched: its tag never lists written keys', () => {
  const nav = defineStore('navigation', () => ({ url: signal('/a'), state: signal('idle') }))
  tag('navigation', { url: '/a', state: 'idle' })
  nav.state.set('loading')
  applyWrittenKeys([tag('navigation', { url: '/b', state: 'idle' })])
  expect(nav.snapshot()).toEqual({ url: '/a', state: 'loading' })
})

// ---- the swap: ordering (S5) ----------------------------------------------------------------------------------------

test('a navigation runs the old level\'s cleanups, then applies written keys, then mounts the new level (once each)', async () => {
  const name = fresh()
  const s = defineStore(name, () => ({ id: signal('1'), count: signal(0) }))
  const log: string[] = []
  defineBehavior('f533_cmp', (ctx) => {
    const who = ctx.el.getAttribute('data-n')!
    ctx.effect(() => { log.push(`${who}:${s.id()}:${s.count()}`) })
    ctx.onCleanup(() => log.push(`cleanup:${who}:${s.id()}`)) // a cleanup reading the store sees the old page's values
    return {}
  })
  const cmp = (who: string) => `<p x-data="f533_cmp" data-n="${who}"></p>`
  show(page(cmp('a'), tagHtml(name, { id: '1', count: 0, '~w': ['id'] })))
  mount()
  s.count.set(5) // a client change the next loader does not write
  await settle()
  const pages: Record<string, string> = { '/b': page(cmp('b'), tagHtml(name, { id: '2', count: 0, '~w': ['id'] })) }
  globalThis.fetch = (async (u: string) => new Response(pages[new URL(String(u)).pathname], { headers: { 'content-type': 'text/html' } })) as typeof fetch
  stop = boot(async () => {})
  log.length = 0
  await (globalThis as Record<symbol, { navigate(u: string): Promise<void> }>)[Symbol.for('brust.nav')]!.navigate('/b')
  await settle()
  expect(location.pathname).toBe('/b')
  // the old component's cleanup ran on id 1 and its effect never saw 2; the new one mounts on 2 and never saw 1
  expect(log).toEqual(['cleanup:a:1', 'b:2:5'])
  expect(s.snapshot()).toEqual({ id: '2', count: 5 })
  // the records the swap flushed never reach the observer: nothing is disposed or mounted twice
  await settle()
  expect(log).toEqual(['cleanup:a:1', 'b:2:5'])
  expect(document.querySelectorAll('[x-data="f533_cmp"]').length).toBe(1)
})
