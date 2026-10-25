// F455: the runtime pieces SPA navigation (design 2026-10-25) needs, pinned without the nav module itself.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
import { __setServerResolver, _resetStores, resolveRecord, type StoreInstanceRecord } from '../src/store/registry'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const rec = (instance: object = {}): StoreInstanceRecord => ({ instance, subs: new Set(), version: { n: 0 }, snap: null })
function storeTag(name: string, json: string): Element {
  const el = document.createElement('script')
  el.setAttribute('type', 'application/json'); el.setAttribute('data-brust-store', name); el.textContent = json
  document.body.appendChild(el)
  return el
}
beforeEach(() => { unmount(); document.head.innerHTML = ''; document.body.innerHTML = '' })
afterEach(() => { __setServerResolver(null); _resetStores() })

test("stores: a live record keeps its state when a second page's snapshot tag appears", () => {
  storeTag('cart', '{"n":1}')
  const seeds: unknown[] = []
  const seed = (_r: StoreInstanceRecord, s: Record<string, unknown>) => { seeds.push(s) }
  const a = resolveRecord('cart', () => rec(), seed)
  storeTag('cart', '{"n":99}')   // page B's snapshot, inserted before the swap
  const b = resolveRecord('cart', () => rec(), seed)
  expect(b).toBe(a)
  expect(seeds).toEqual([{ n: 1 }])   // never re-read: the client value survives (design 5.5)
})

test('stores: a store first used later is seeded from the tag present at that moment', () => {
  storeTag('theme', '{"dark":false}')
  const seeds: unknown[] = []
  const seed = (_r: StoreInstanceRecord, s: Record<string, unknown>) => { seeds.push(s) }
  resolveRecord('theme', () => rec(), seed)
  storeTag('profile', '{"handle":"ash"}')   // arrives with page B
  expect(seeds.length).toBe(1)
  resolveRecord('profile', () => rec(), seed)
  expect(seeds).toEqual([{ dark: false }, { handle: 'ash' }])
})

test("F301: a host mounted late (a navigation's markup) raises no first-paint alarm; a booted-page host still does", async () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  try {
    defineBehavior('f301', () => ({ label: signal('client') }))
    document.body.innerHTML = '<p id="a" x-data="f301" x-text="label">server</p>'
    mount()
    expect(warns.filter((w) => w.includes('first-paint mismatch')).length).toBe(1)   // control: the tripwire is live on the first page
    warns.length = 0
    document.body.insertAdjacentHTML('beforeend', '<p id="b" x-data="f301" x-text="label">server B</p>')
    await tick()
    expect(document.getElementById('b')!.textContent).toBe('client')
    expect(warns.filter((w) => w.includes('first-paint mismatch'))).toEqual([])
  } finally { console.warn = orig }
})

test('boot order: the core first imported while the body holds page A, then the body becomes page B', async () => {
  const log: string[] = []
  defineBehavior('boot_cmp', (ctx) => {
    const name = ctx.el.getAttribute('data-n')!
    log.push(`mount:${name}:${ctx.late}`)
    ctx.onCleanup(() => log.push(`dispose:${name}`))
  })
  document.body.innerHTML = '<div x-data="boot_cmp" data-n="A"></div>'
  const spec = '../src/mount?boot-order'   // a variable specifier: typed as any
  const fresh = (await import(spec)) as typeof import('../src/mount')   // a fresh module copy: its first mount() is the core's boot
  fresh.mount(document.body)
  expect(log).toEqual(['mount:A:false'])
  document.body.replaceChildren(...Array.from(new DOMParser().parseFromString('<div x-data="boot_cmp" data-n="B"></div>', 'text/html').body.children))
  await tick()
  expect(log).toEqual(['mount:A:false', 'dispose:A', 'mount:B:true'])
  fresh.unmount(document.body)
})
