import { beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

// Fresh happy-dom window per test; assign globals the runtime reads.
function setupDom(html: string): Window {
  const win = new Window()
  // happy-dom 20.9.0 under Bun: Window does not expose SyntaxError, and its
  // SelectorParser reaches `new this.window.SyntaxError(...)` on EVERY selector,
  // throwing a TypeError that breaks all querySelectorAll calls. Polyfill it so
  // selector queries work. (Env quirk only — no behavior assertion is affected.)
  // @ts-expect-error happy-dom Window lacks SyntaxError; alias the global one
  win.SyntaxError = SyntaxError
  win.document.body.innerHTML = html
  // @ts-expect-error assign happy-dom globals onto globalThis for the runtime
  globalThis.document = win.document
  // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver
  // @ts-expect-error
  globalThis.HTMLElement = win.HTMLElement
  return win
}

describe('x-data mount', () => {
  beforeEach(() => {
    // Re-import a fresh module per test to reset the registry + started flag.
  })

  test('instantiates a registered behavior and parses x-props JSON', async () => {
    const win = setupDom('<div x-data="probe" x-props=\'{"id":"7"}\'></div>')
    const seen: any[] = []
    const { register, start } = await import(`./runtime.ts?mount=${Math.random()}`)
    register('probe', ({ el, props }: any) => {
      seen.push({ tag: el.tagName, props })
      return {}
    })
    start(win.document)
    expect(seen).toHaveLength(1)
    expect(seen[0].props).toEqual({ id: '7' })
    expect(seen[0].tag).toBe('DIV')
  })

  test('runs init() exactly once after mount', async () => {
    const win = setupDom('<div x-data="probe2"></div>')
    let inits = 0
    const { register, start } = await import(`./runtime.ts?init=${Math.random()}`)
    register('probe2', () => ({
      init() {
        inits++
      },
    }))
    start(win.document)
    start(win.document) // idempotent — must not re-mount
    expect(inits).toBe(1)
  })

  test('unknown component warns and skips (no throw)', async () => {
    const win = setupDom('<div x-data="missing"></div>')
    const { start } = await import(`./runtime.ts?unknown=${Math.random()}`)
    expect(() => start(win.document)).not.toThrow()
  })
})

describe('x-text', () => {
  test('binds initial value and updates on signal change; reads a computed', async () => {
    const win = setupDom('<div x-data="t1"><span x-text="label"></span><b x-text="msg"></b></div>')
    const { register, start } = await import(`./runtime.ts?xtext=${Math.random()}`)
    const { signal, computed } = await import('../store/index.ts')
    const n = signal(1)
    register('t1', () => ({ msg: n, label: computed(() => `n=${n()}`) }))
    start(win.document)
    const span = win.document.querySelector('span')!
    const b = win.document.querySelector('b')!
    expect(span.textContent).toBe('n=1')
    expect(b.textContent).toBe('1')
    n.set(5)
    expect(span.textContent).toBe('n=5')
    expect(b.textContent).toBe('5')
  })

  test('removing the x-data element disposes effects (no detached update)', async () => {
    const win = setupDom('<div id="host"><div x-data="t2"><span x-text="msg"></span></div></div>')
    const { register, start } = await import(`./runtime.ts?disp=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const n = signal('a')
    register('t2', () => ({ msg: n }))
    start(win.document)
    const span = win.document.querySelector('span')!
    expect(span.textContent).toBe('a')
    win.document.getElementById('host')!.innerHTML = '' // MutationObserver fires removal
    await Promise.resolve() // let the observer callback run
    n.set('b') // must NOT update the detached span / must not throw
    expect(span.textContent).toBe('a')
  })
})

describe('x-show + x-bind', () => {
  test('x-show toggles display', async () => {
    const win = setupDom('<div x-data="s1"><p x-show="open">hi</p></div>')
    const { register, start } = await import(`./runtime.ts?show=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const open = signal(false)
    register('s1', () => ({ open }))
    start(win.document)
    const p = win.document.querySelector('p')!
    expect(p.style.display).toBe('none')
    open.set(true)
    expect(p.style.display).toBe('')
  })

  test('x-bind-class sets className; x-bind-disabled toggles property+attr; generic attr', async () => {
    const win = setupDom(
      '<div x-data="s2"><button x-bind-class="cls" x-bind-disabled="busy" x-bind-data-x="tag">b</button></div>',
    )
    const { register, start } = await import(`./runtime.ts?bind=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const cls = signal('a b')
    const busy = signal(true)
    const tag = signal('v1')
    register('s2', () => ({ cls, busy, tag }))
    start(win.document)
    const btn = win.document.querySelector('button')! as any
    expect(btn.className).toBe('a b')
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('disabled')).toBe('')
    expect(btn.getAttribute('data-x')).toBe('v1')
    busy.set(false)
    cls.set('c')
    expect(btn.disabled).toBe(false)
    expect(btn.hasAttribute('disabled')).toBe(false)
    expect(btn.className).toBe('c')
  })
})

describe('x-on', () => {
  test('x-on-click calls the named method with the event', async () => {
    const win = setupDom('<div x-data="o1"><button x-on-click="inc">+</button></div>')
    const { register, start } = await import(`./runtime.ts?on=${Math.random()}`)
    let calls = 0
    let lastType = ''
    register('o1', () => ({
      inc(e: Event) {
        calls++
        lastType = e.type
      },
    }))
    start(win.document)
    const btn = win.document.querySelector('button')!
    btn.dispatchEvent(new win.Event('click', { bubbles: true }))
    expect(calls).toBe(1)
    expect(lastType).toBe('click')
  })

  test('x-on target that is not a function warns, does not throw', async () => {
    const win = setupDom('<div x-data="o2"><button x-on-click="nope">x</button></div>')
    const { register, start } = await import(`./runtime.ts?on2=${Math.random()}`)
    register('o2', () => ({ nope: 5 }))
    start(win.document)
    const btn = win.document.querySelector('button')!
    expect(() => btn.dispatchEvent(new win.Event('click', { bubbles: true }))).not.toThrow()
  })
})

describe('x-for', () => {
  test('renders one node per item, updates on change, child reads loop item + instance member', async () => {
    const win = setupDom(
      '<ul x-data="f1"><li x-for="t in items" x-text="t.name" x-bind-class="cls"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?for=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal([{ name: 'fire' }, { name: 'water' }])
    register('f1', () => ({ items, cls: signal('chip') }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    let lis = ul.querySelectorAll('li')
    expect(Array.from(lis).map((l) => l.textContent)).toEqual(['fire', 'water'])
    expect(lis[0]!.className).toBe('chip') // instance member visible in loop scope
    items.set([{ name: 'grass' }])
    lis = ul.querySelectorAll('li')
    expect(Array.from(lis).map((l) => l.textContent)).toEqual(['grass'])
  })

  test('malformed x-for expression warns and skips', async () => {
    const win = setupDom('<ul x-data="f2"><li x-for="garbage" x-text="t"></li></ul>')
    const { register, start } = await import(`./runtime.ts?for2=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    register('f2', () => ({ items: signal([]) }))
    expect(() => start(win.document)).not.toThrow()
  })

  test('keyed: reorder preserves node identity', async () => {
    const win = setupDom(
      '<ul x-data="k1"><li x-for="t in items by t.id" x-text="t.name"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?k1=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    register('k1', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    const before = Array.from(ul.querySelectorAll('li'))
    expect(before.map((l) => l.textContent)).toEqual(['a', 'b'])
    items.set([
      { id: 2, name: 'b' },
      { id: 1, name: 'a' },
    ]) // swap
    const after = Array.from(ul.querySelectorAll('li'))
    expect(after.map((l) => l.textContent)).toEqual(['b', 'a'])
    expect(after[0]).toBe(before[1]) // SAME node object — reused, not rebuilt
    expect(after[1]).toBe(before[0])
  })

  test('keyed: value change on kept key updates same node', async () => {
    const win = setupDom(
      '<ul x-data="k2"><li x-for="t in items by t.id" x-text="t.name"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?k2=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal([{ id: 1, name: 'old' }])
    register('k2', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    const before = ul.querySelector('li')!
    expect(before.textContent).toBe('old')
    items.set([{ id: 1, name: 'new' }])
    const after = ul.querySelector('li')!
    expect(after).toBe(before) // same node ref
    expect(after.textContent).toBe('new')
  })

  test('keyed: index reactive on reorder', async () => {
    const win = setupDom(
      '<ul x-data="k3"><li x-for="(t, i) in items by t.id" x-text="i"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?k3=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    register('k3', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    const before = Array.from(ul.querySelectorAll('li'))
    expect(before.map((l) => l.textContent)).toEqual(['0', '1'])
    items.set([
      { id: 2, name: 'b' },
      { id: 1, name: 'a' },
    ]) // swap
    const after = Array.from(ul.querySelectorAll('li'))
    // id=2 now at index 0, id=1 now at index 1 — same node refs, new indices
    expect(after[0]).toBe(before[1])
    expect(after[1]).toBe(before[0])
    expect(after.map((l) => l.textContent)).toEqual(['0', '1'])
  })

  test('keyed: insert/delete touch only changed keys', async () => {
    const win = setupDom(
      '<ul x-data="k4"><li x-for="t in items by t.id" x-text="t.name"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?k4=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    register('k4', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    const before = Array.from(ul.querySelectorAll('li'))
    // insert one in the middle
    items.set([
      { id: 1, name: 'a' },
      { id: 3, name: 'c' },
      { id: 2, name: 'b' },
    ])
    let after = Array.from(ul.querySelectorAll('li'))
    expect(after.map((l) => l.textContent)).toEqual(['a', 'c', 'b'])
    expect(after[0]).toBe(before[0]) // id=1 kept
    expect(after[2]).toBe(before[1]) // id=2 kept
    const inserted = after[1]!
    // delete one
    items.set([
      { id: 1, name: 'a' },
      { id: 3, name: 'c' },
    ])
    after = Array.from(ul.querySelectorAll('li'))
    expect(after.map((l) => l.textContent)).toEqual(['a', 'c'])
    expect(after[0]).toBe(before[0]) // id=1 still kept
    expect(after[1]).toBe(inserted) // id=3 still kept
    expect(after.includes(before[1]!)).toBe(false) // id=2 gone
  })

  test('keyed: composite key avoids collision', async () => {
    const win = setupDom(
      '<ul x-data="k5"><li x-for="t in items by t.a, t.b" x-text="t.name"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?k5=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    // "1","23" vs "12","3" must NOT collide (NUL join)
    const items = signal([
      { a: 1, b: 23, name: 'x' },
      { a: 12, b: 3, name: 'y' },
    ])
    register('k5', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    const lis = Array.from(ul.querySelectorAll('li'))
    expect(lis).toHaveLength(2)
    expect(lis.map((l) => l.textContent)).toEqual(['x', 'y'])
  })

  test('keyed: duplicate key warns, does not crash', async () => {
    const win = setupDom(
      '<ul x-data="k6"><li x-for="t in items by t.id" x-text="t.name"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?k6=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const warn = console.warn
    const calls: unknown[][] = []
    console.warn = (...a: unknown[]) => {
      calls.push(a)
    }
    try {
      const items = signal([
        { id: 1, name: 'a' },
        { id: 1, name: 'b' },
      ])
      register('k6', () => ({ items }))
      expect(() => start(win.document)).not.toThrow()
      const ul = win.document.querySelector('ul')!
      const lis = Array.from(ul.querySelectorAll('li'))
      expect(lis).toHaveLength(2) // both still rendered
      expect(lis.map((l) => l.textContent)).toEqual(['a', 'b'])
      expect(calls.some((a) => String(a[0]).includes('duplicate x-for key'))).toBe(true)
    } finally {
      console.warn = warn
    }
  })

  test('keyed: focus survives reorder (node identity = focus survival)', async () => {
    // happy-dom drops document.activeElement on ANY insertBefore-move of the focused
    // node or its ancestor (verified: a bare ul.insertBefore(li, ...) clears it too),
    // so we cannot assert activeElement here. In a real browser, insertBefore MOVES a
    // node and preserves focus — the reconcile's load-bearing guarantee is that the
    // focused input is the SAME node object after reorder (reused, not rebuilt), which
    // is what makes focus/scroll/uncontrolled-input state survive. Phase 6 verifies the
    // live-browser activeElement behavior; here we lock node identity through the move.
    const win = setupDom(
      '<ul x-data="k7"><li x-for="t in items by t.id"><input x-bind-value="t.name"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?k7=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    register('k7', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    const inputs = Array.from(ul.querySelectorAll('input'))
    const target = inputs[1]! // id=2's input
    target.focus()
    expect(win.document.activeElement).toBe(target) // focus took before any move
    items.set([
      { id: 2, name: 'b' },
      { id: 1, name: 'a' },
    ]) // swap
    // SAME input node now at position 0 — reused via insertBefore move, not rebuilt.
    expect(Array.from(ul.querySelectorAll('input'))[0]).toBe(target)
    expect((target as unknown as { value: string }).value).toBe('b') // value reactive
  })

  test('keyed: unmount disposes all live entries', async () => {
    const win = setupDom(
      '<div id="host"><ul x-data="k8"><li x-for="t in items by t.id" x-text="t.name"></li></ul></div>',
    )
    const { register, start } = await import(`./runtime.ts?k8=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    // per-item name signal — after unmount, setting it must NOT update a detached node
    const n1 = signal('a')
    const items = signal([{ id: 1, name: n1 }])
    register('k8', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    const li = ul.querySelector('li')!
    expect(li.textContent).toBe('a')
    win.document.getElementById('host')!.innerHTML = '' // remove host → disposeTree
    await Promise.resolve()
    n1.set('b') // must NOT update detached node / must not throw
    expect(li.textContent).toBe('a')
  })

  test('legacy index: (t, i) in items without by', async () => {
    const win = setupDom('<ul x-data="k9"><li x-for="(t, i) in items" x-text="i"></li></ul>')
    const { register, start } = await import(`./runtime.ts?k9=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    register('k9', () => ({ items }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    expect(Array.from(ul.querySelectorAll('li')).map((l) => l.textContent)).toEqual(['0', '1', '2'])
    items.set([{ name: 'x' }])
    expect(Array.from(ul.querySelectorAll('li')).map((l) => l.textContent)).toEqual(['0'])
  })
})

describe('x-for SSR adopt', () => {
  test('adopt reuses node identity (no double-mount)', async () => {
    const win = setupDom(
      '<div id="grid" x-data="dex">' +
        '<a x-for="c in items by c.id" data-x-key="1" href="#"><span x-text="c.label">a</span></a>' +
        '<a x-for="c in items by c.id" data-x-key="2" href="#"><span x-text="c.label">b</span></a>' +
        '</div>',
    )
    const { register, start } = await import(`./runtime.ts?adopt1=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    register('dex', ({ props }: any) => ({ items: signal(props.items) }))
    // seed props via x-props on the host so the behavior gets items
    win.document.getElementById('grid')!.setAttribute(
      'x-props',
      JSON.stringify({
        items: [
          { id: 1, label: 'a' },
          { id: 2, label: 'b' },
        ],
      }),
    )
    const grid = win.document.getElementById('grid')!
    const beforeFirst = grid.querySelectorAll('a')[0]!
    start(win.document)
    const after = grid.querySelectorAll('#grid > a')
    expect(after).toHaveLength(2) // NOT 4 — no double-mount
    expect(after[0]).toBe(beforeFirst) // SAME object — adopted, not re-cloned
  })

  test('reactivity wired onto adopted node', async () => {
    const win = setupDom(
      '<div id="grid" x-data="dex2" x-props=\'{"items":[{"id":1,"label":"a"},{"id":2,"label":"b"}]}\'>' +
        '<a x-for="c in items by c.id" data-x-key="1"><span x-text="c.label">a</span></a>' +
        '<a x-for="c in items by c.id" data-x-key="2"><span x-text="c.label">b</span></a>' +
        '</div>',
    )
    const { register, start } = await import(`./runtime.ts?adopt2=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal<any>([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
    ])
    register('dex2', () => ({ items }))
    start(win.document)
    items.set([
      { id: 1, label: 'A' },
      { id: 2, label: 'b' },
    ])
    const span = win.document.querySelector('a[data-x-key="1"] span')!
    expect(span.textContent).toBe('A')
  })

  test('filter reconciles, kept node REUSED', async () => {
    const win = setupDom(
      '<div id="grid" x-data="dex3">' +
        '<a x-for="c in items by c.id" data-x-key="1"><span x-text="c.label">a</span></a>' +
        '<a x-for="c in items by c.id" data-x-key="2"><span x-text="c.label">b</span></a>' +
        '</div>',
    )
    const { register, start } = await import(`./runtime.ts?adopt3=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal<any>([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
    ])
    register('dex3', () => ({ items }))
    start(win.document)
    const grid = win.document.getElementById('grid')!
    const keptId2 = grid.querySelector('a[data-x-key="2"]')!
    items.set([{ id: 2, label: 'b' }])
    const remaining = grid.querySelectorAll('#grid > a')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toBe(keptId2) // id=2 reused
    expect(grid.querySelector('a[data-x-key="1"]')).toBeNull() // id=1 gone
  })

  test('legacy clone-fresh unchanged (no data-x-key seed)', async () => {
    const win = setupDom(
      '<ul id="list" x-data="dex4"><li x-for="c in items by c.id" x-text="c.label"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?adopt4=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal<any>([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
      { id: 3, label: 'c' },
    ])
    register('dex4', () => ({ items }))
    const list = win.document.getElementById('list')!
    const templateLi = list.querySelector('li')!
    start(win.document)
    const lis = list.querySelectorAll('#list > li')
    expect(lis).toHaveLength(3) // one per item, freshly cloned
    expect(Array.from(lis).map((l) => l.textContent)).toEqual(['a', 'b', 'c'])
    expect(Array.from(lis).includes(templateLi as any)).toBe(false) // template removed, not reused
  })

  test('idempotency: 2-seed mounts once, re-set same items does not duplicate', async () => {
    const win = setupDom(
      '<div id="grid" x-data="dex5">' +
        '<a x-for="c in items by c.id" data-x-key="1"><span x-text="c.label">a</span></a>' +
        '<a x-for="c in items by c.id" data-x-key="2"><span x-text="c.label">b</span></a>' +
        '</div>',
    )
    const { register, start } = await import(`./runtime.ts?adopt5=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal<any>([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
    ])
    register('dex5', () => ({ items }))
    start(win.document)
    const grid = win.document.getElementById('grid')!
    expect(grid.querySelectorAll('#grid > a')).toHaveLength(2)
    items.set([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
    ]) // same keys
    expect(grid.querySelectorAll('#grid > a')).toHaveLength(2) // no duplication
  })

  test('static fallback when the list has no backing signal', async () => {
    const win = setupDom(
      '<div id="grid" x-data="dexNoSig">' +
        '<a x-for="t in items by t.id" data-x-key="1"><span x-text="t.label">A</span></a>' +
        '<a x-for="t in items by t.id" data-x-key="2"><span x-text="t.label">B</span></a>' +
        '</div>',
    )
    const { register, start } = await import(`./runtime.ts?adoptStatic=${Math.random()}`)
    // Behavior instance exposes NO `items` — sugar-marked x-for without a backing signal.
    register('dexNoSig', () => ({ other: 1 }))
    const grid = win.document.getElementById('grid')!
    const beforeFirst = grid.querySelectorAll('a')[0]!
    const beforeSecond = grid.querySelectorAll('a')[1]!
    start(win.document)
    const after = grid.querySelectorAll('#grid > a')
    expect(after).toHaveLength(2) // seeds NOT wiped
    expect(after[0]).toBe(beforeFirst) // identity unchanged
    expect(after[1]).toBe(beforeSecond)
    // x-text NOT cleared — guard left the subtree fully static.
    expect(after[0].querySelector('span')!.textContent).toBe('A')
    expect(after[1].querySelector('span')!.textContent).toBe('B')
  })

  test('adopts when a signal IS present (regression)', async () => {
    const win = setupDom(
      '<div id="grid" x-data="dexSig">' +
        '<a x-for="t in items by t.id" data-x-key="1"><span x-text="t.label">A</span></a>' +
        '<a x-for="t in items by t.id" data-x-key="2"><span x-text="t.label">B</span></a>' +
        '</div>',
    )
    const { register, start } = await import(`./runtime.ts?adoptSig=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const items = signal<any>([
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
    ])
    register('dexSig', () => ({ items }))
    const grid = win.document.getElementById('grid')!
    const beforeFirst = grid.querySelectorAll('a')[0]!
    start(win.document)
    expect(grid.querySelectorAll('#grid > a')).toHaveLength(2) // adopted, not double-mounted
    expect(grid.querySelectorAll('a')[0]).toBe(beforeFirst) // identity reused
    const keptId2 = grid.querySelector('a[data-x-key="2"]')!
    items.set([{ id: 2, label: 'B' }]) // reconcile to 1 node
    const remaining = grid.querySelectorAll('#grid > a')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toBe(keptId2) // id=2 reused
    expect(grid.querySelector('a[data-x-key="1"]')).toBeNull() // id=1 removed
  })
})

describe('parseFor', () => {
  test('grammar forms', async () => {
    const { parseFor } = await import(`./runtime.ts?pf=${Math.random()}`)
    expect(parseFor('t in items')).toEqual({
      itemName: 't',
      indexName: undefined,
      listPath: 'items',
      keyPaths: undefined,
    })
    expect(parseFor('(t, i) in items')).toEqual({
      itemName: 't',
      indexName: 'i',
      listPath: 'items',
      keyPaths: undefined,
    })
    expect(parseFor('t in items by t.id')).toEqual({
      itemName: 't',
      indexName: undefined,
      listPath: 'items',
      keyPaths: ['t.id'],
    })
    expect(parseFor('(t, i) in items by t.id, t.color')).toEqual({
      itemName: 't',
      indexName: 'i',
      listPath: 'items',
      keyPaths: ['t.id', 't.color'],
    })
    // malformed → null
    for (const bad of [
      'garbage',
      't in',
      'in items',
      '(a,b,c) in x',
      't in items by',
      't in items by !',
      't in it ems',
    ]) {
      expect(parseFor(bad)).toBeNull()
    }
  })
})

describe('read (unwrap each hop)', () => {
  test('leaf + intermediate + plain + computed + fn + null', async () => {
    const { read } = await import(`./runtime.ts?rd=${Math.random()}`)
    const { signal, computed } = await import('../store/index.ts')
    // leaf signal (regression)
    expect(read({ n: signal(5) }, 'n')).toBe(5)
    // intermediate signal unwrapped then descended (NEW)
    expect(read({ item: signal({ name: 'fire' }) }, 'item.name')).toBe('fire')
    // plain nested path unchanged
    expect(read({ a: { b: 'x' } }, 'a.b')).toBe('x')
    // computed at leaf
    expect(read({ c: computed(() => 9) }, 'c')).toBe(9)
    // zero-arg function at leaf called (regression)
    expect(read({ f: () => 'r' }, 'f')).toBe('r')
    // null mid-path
    expect(read({ a: null }, 'a.b')).toBeUndefined()
  })
})

describe('lifecycle', () => {
  test('dynamic add mounts; nested x-data is independent and not double-bound by the outer', async () => {
    const win = setupDom('<div id="host"></div>')
    const { register, start } = await import(`./runtime.ts?life=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    let outerInits = 0
    let innerInits = 0
    register('outer', () => ({
      init() {
        outerInits++
      },
      msg: signal('O'),
    }))
    register('inner', () => ({
      init() {
        innerInits++
      },
      msg: signal('I'),
    }))
    start(win.document)
    // dynamically inject an outer wrapping an inner, each with its own x-text
    win.document.getElementById('host')!.innerHTML =
      '<div x-data="outer"><span class="o" x-text="msg"></span>' +
      '<div x-data="inner"><span class="i" x-text="msg"></span></div></div>'
    await Promise.resolve()
    expect(outerInits).toBe(1)
    expect(innerInits).toBe(1)
    expect(win.document.querySelector('.o')!.textContent).toBe('O')
    expect(win.document.querySelector('.i')!.textContent).toBe('I') // inner owns its subtree
  })

  test('SPA-nav swap shape: remove old x-data + add new in one batch → dispose then mount', async () => {
    const win = setupDom(
      '<main id="m"><div x-data="pg" x-props=\'{"v":"1"}\'><span x-text="v"></span></div></main>',
    )
    const { register, start } = await import(`./runtime.ts?swap=${Math.random()}`)
    const mounts: string[] = []
    register('pg', ({ props }: any) => {
      mounts.push(props.v)
      return { v: props.v }
    })
    start(win.document)
    expect(mounts).toEqual(['1'])
    expect(win.document.querySelector('span')!.textContent).toBe('1')
    // emulate swapMainContent: replace the <main> contents wholesale
    win.document.getElementById('m')!.innerHTML =
      '<div x-data="pg" x-props=\'{"v":"2"}\'><span x-text="v"></span></div>'
    await Promise.resolve()
    expect(mounts).toEqual(['1', '2']) // old disposed, new mounted exactly once
    expect(win.document.querySelector('span')!.textContent).toBe('2')
  })
})

describe('x-if', () => {
  test('truthy initial: original element adopted in place (same node, no re-clone)', async () => {
    const win = setupDom('<div x-data="if1"><p x-if="open" x-text="msg">seed</p></div>')
    const { register, start } = await import(`./runtime.ts?if1=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const open = signal(true)
    const msg = signal('hi')
    register('if1', () => ({ open, msg }))
    const before = win.document.querySelector('p')!
    start(win.document)
    const after = win.document.querySelector('p')!
    expect(after).toBe(before) // SAME node object — adopted, not re-cloned
    expect(after.textContent).toBe('hi') // subtree bindings live on the original
  })

  test('falsy initial: element removed from the DOM', async () => {
    const win = setupDom('<div x-data="if2"><p x-if="open">hi</p></div>')
    const { register, start } = await import(`./runtime.ts?if2=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    register('if2', () => ({ open: signal(false) }))
    start(win.document)
    expect(win.document.querySelector('p')).toBeNull()
  })

  test('toggle cycle inserts a FRESH clone each time (no stale state carried)', async () => {
    const win = setupDom('<div x-data="if3"><p x-if="open" x-text="msg"></p></div>')
    const { register, start } = await import(`./runtime.ts?if3=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const open = signal(false)
    register('if3', () => ({ open, msg: signal('m') }))
    start(win.document)
    expect(win.document.querySelector('p')).toBeNull()
    open.set(true)
    const clone1 = win.document.querySelector('p')!
    expect(clone1.textContent).toBe('m') // fresh clone is bound
    clone1.setAttribute('data-dirty', '1') // mutate clone 1
    open.set(false)
    expect(win.document.querySelector('p')).toBeNull()
    open.set(true)
    const clone2 = win.document.querySelector('p')!
    expect(clone2).not.toBe(clone1) // fresh clone, not the old node
    expect(clone2.hasAttribute('data-dirty')).toBe(false) // clone 2 clean
    expect(clone2.textContent).toBe('m')
  })

  test('inner x-text effect and x-on listener are disposed when x-if turns falsy', async () => {
    const win = setupDom(
      '<div x-data="if4"><p x-if="open"><span x-text="msg"></span><button x-on-click="inc">b</button></p></div>',
    )
    const { register, start } = await import(`./runtime.ts?if4=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const open = signal(true)
    const msg = signal('a')
    let calls = 0
    register('if4', () => ({
      open,
      msg,
      inc() {
        calls++
      },
    }))
    start(win.document)
    const span = win.document.querySelector('span')!
    const btn = win.document.querySelector('button')!
    expect(span.textContent).toBe('a')
    btn.dispatchEvent(new win.Event('click', { bubbles: true }))
    expect(calls).toBe(1)
    open.set(false) // unmount → per-clone disposers run
    msg.set('b') // must NOT update the detached span
    expect(span.textContent).toBe('a')
    btn.dispatchEvent(new win.Event('click', { bubbles: true })) // listener removed
    expect(calls).toBe(1)
  })

  test('x-if + x-for on the same element warns and skips x-if (x-for proceeds)', async () => {
    const win = setupDom(
      '<ul x-data="if5"><li x-for="t in items" x-if="open" x-text="t.n"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?if5=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const warn = console.warn
    const calls: unknown[][] = []
    console.warn = (...a: unknown[]) => {
      calls.push(a)
    }
    try {
      register('if5', () => ({ items: signal([{ n: 'a' }, { n: 'b' }]), open: signal(false) }))
      expect(() => start(win.document)).not.toThrow()
      expect(calls.some((a) => String(a[0]).includes('x-if'))).toBe(true)
      // x-for proceeded; x-if was skipped (open=false would have removed everything)
      const lis = Array.from(win.document.querySelectorAll('li'))
      expect(lis.map((l) => l.textContent)).toEqual(['a', 'b'])
    } finally {
      console.warn = warn
    }
  })

  test('nested x-data inside x-if mounts via the observer on insert, disposes on removal', async () => {
    const win = setupDom(
      '<div x-data="ifOuter"><section x-if="open"><div x-data="ifInner"><span x-text="msg"></span></div></section></div>',
    )
    const { register, start } = await import(`./runtime.ts?if6=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const open = signal(false)
    const msg = signal('I')
    let innerInits = 0
    register('ifOuter', () => ({ open }))
    register('ifInner', () => ({
      init() {
        innerInits++
      },
      msg,
    }))
    start(win.document)
    expect(innerInits).toBe(0) // falsy initial — nested x-data never mounted
    open.set(true) // clone inserted → observer mounts the nested x-data
    await Promise.resolve()
    expect(innerInits).toBe(1)
    const span = win.document.querySelector('span')!
    expect(span.textContent).toBe('I')
    open.set(false) // removal → observer disposes the nested x-data
    await Promise.resolve()
    msg.set('J') // must NOT update the detached nested subtree
    expect(span.textContent).toBe('I')
  })
})

describe('x-model', () => {
  test('text input: two-way (input event writes signal; signal.set reflects to value)', async () => {
    const win = setupDom('<div x-data="m1"><input x-model="q"></div>')
    const { register, start } = await import(`./runtime.ts?m1=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const q = signal('a')
    register('m1', () => ({ q }))
    start(win.document)
    const input = win.document.querySelector('input')! as any
    expect(input.value).toBe('a') // initial reflect
    input.value = 'ab'
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(q()).toBe('ab') // write path
    q.set('z')
    expect(input.value).toBe('z') // read path
  })

  test('checkbox: change event writes boolean; signal drives checked', async () => {
    const win = setupDom('<div x-data="m2"><input type="checkbox" x-model="on"></div>')
    const { register, start } = await import(`./runtime.ts?m2=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const on = signal(false)
    register('m2', () => ({ on }))
    start(win.document)
    const input = win.document.querySelector('input')! as any
    expect(input.checked).toBe(false)
    input.checked = true
    input.dispatchEvent(new win.Event('change', { bubbles: true }))
    expect(on()).toBe(true) // boolean, not string
    on.set(false)
    expect(input.checked).toBe(false)
  })

  test('radio group: signal drives checked switch; change writes the checked value', async () => {
    const win = setupDom(
      '<div x-data="m3">' +
        '<input type="radio" name="g" value="a" x-model="pick">' +
        '<input type="radio" name="g" value="b" x-model="pick">' +
        '</div>',
    )
    const { register, start } = await import(`./runtime.ts?m3=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const pick = signal('a')
    register('m3', () => ({ pick }))
    start(win.document)
    const radios = Array.from(win.document.querySelectorAll('input')) as any[]
    expect(radios[0].checked).toBe(true)
    expect(radios[1].checked).toBe(false)
    pick.set('b') // signal drives the switch
    expect(radios[0].checked).toBe(false)
    expect(radios[1].checked).toBe(true)
    radios[0].checked = true
    radios[0].dispatchEvent(new win.Event('change', { bubbles: true }))
    expect(pick()).toBe('a') // checked radio writes its value
    expect(radios[1].checked).toBe(false) // reflect effect updates the sibling
  })

  test('select (single): input event writes value; signal reflects', async () => {
    const win = setupDom(
      '<div x-data="m4"><select x-model="sel">' +
        '<option value="x">X</option><option value="y">Y</option>' +
        '</select></div>',
    )
    const { register, start } = await import(`./runtime.ts?m4=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const sel = signal('x')
    register('m4', () => ({ sel }))
    start(win.document)
    const select = win.document.querySelector('select')! as any
    expect(select.value).toBe('x')
    select.value = 'y'
    select.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(sel()).toBe('y')
    sel.set('x')
    expect(select.value).toBe('x')
  })

  test('select[multiple]: warns at bind time, registers no listener', async () => {
    const win = setupDom(
      '<div x-data="m5"><select multiple x-model="sel">' +
        '<option value="x">X</option><option value="y">Y</option>' +
        '</select></div>',
    )
    const { register, start } = await import(`./runtime.ts?m5=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const warn = console.warn
    const calls: unknown[][] = []
    console.warn = (...a: unknown[]) => {
      calls.push(a)
    }
    try {
      const sel = signal('x')
      register('m5', () => ({ sel }))
      start(win.document)
      expect(calls.some((a) => String(a[0]).includes('multiple'))).toBe(true)
      const select = win.document.querySelector('select')! as any
      select.value = 'y'
      select.dispatchEvent(new win.Event('input', { bubbles: true }))
      expect(sel()).toBe('x') // no listener — signal untouched
    } finally {
      console.warn = warn
    }
  })

  test('no echo loop: one input dispatch → exactly one signal set', async () => {
    const win = setupDom('<div x-data="m6"><input x-model="q"></div>')
    const { register, start } = await import(`./runtime.ts?m6=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const q = signal('a')
    const sets: unknown[] = []
    const origSet = q.set
    q.set = (v: any) => {
      sets.push(v)
      origSet(v)
    }
    register('m6', () => ({ q }))
    start(win.document)
    expect(sets).toHaveLength(0) // initial reflect never writes the signal
    const input = win.document.querySelector('input')! as any
    input.value = 'ab'
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(sets).toEqual(['ab']) // exactly one set; reflect guard breaks the echo
  })

  test('writePath: multi-hop through an intermediate signal hop reaches the leaf signal', async () => {
    const win = setupDom('<div x-data="m7"><input x-model="item.name"></div>')
    const { register, start } = await import(`./runtime.ts?m7=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const name = signal('a')
    const item = signal({ name })
    register('m7', () => ({ item }))
    start(win.document)
    const input = win.document.querySelector('input')! as any
    expect(input.value).toBe('a') // read unwraps the intermediate hop
    input.value = 'b'
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(name()).toBe('b') // write unwraps the intermediate hop too
  })

  test('disposal: unmount removes the listener (no signal write) and the reflect effect', async () => {
    const win = setupDom('<div id="host"><div x-data="m8"><input x-model="q"></div></div>')
    const { register, start } = await import(`./runtime.ts?m8=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const q = signal('a')
    register('m8', () => ({ q }))
    start(win.document)
    const input = win.document.querySelector('input')! as any
    expect(input.value).toBe('a')
    win.document.getElementById('host')!.innerHTML = '' // unmount → observer disposes
    await Promise.resolve()
    input.value = 'zz'
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(q()).toBe('a') // listener removed — no write after unmount
    q.set('y')
    expect(input.value).toBe('zz') // reflect effect disposed too
  })
})

describe('behavior ctx: effect + onCleanup', () => {
  test('ctx.effect runs reactively; its disposer joins the lifecycle (no run after unmount)', async () => {
    const win = setupDom('<div id="host"><div x-data="fx"></div></div>')
    const { register, start } = await import(`./runtime.ts?fx=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const n = signal(0)
    const runs: number[] = []
    register('fx', ({ effect }: any) => {
      effect(() => {
        runs.push(n())
      })
      return {}
    })
    start(win.document)
    expect(runs).toEqual([0]) // runs immediately on mount
    n.set(1)
    expect(runs).toEqual([0, 1]) // reactive
    win.document.getElementById('host')!.innerHTML = '' // unmount → observer disposes
    await Promise.resolve()
    n.set(2)
    expect(runs).toEqual([0, 1]) // disposer joined lifecycle → no detached run
  })

  test('ctx.effect returned cleanup runs before each re-run and once on unmount', async () => {
    const win = setupDom('<div id="host"><div x-data="fx2"></div></div>')
    const { register, start } = await import(`./runtime.ts?fx2=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const n = signal(0)
    const log: string[] = []
    register('fx2', ({ effect }: any) => {
      effect(() => {
        const v = n()
        return () => log.push(`cleanup:${v}`)
      })
      return {}
    })
    start(win.document)
    expect(log).toEqual([])
    n.set(1)
    expect(log).toEqual(['cleanup:0']) // prev cleanup fires before re-run
    win.document.getElementById('host')!.innerHTML = ''
    await Promise.resolve()
    expect(log).toEqual(['cleanup:0', 'cleanup:1']) // final cleanup on unmount
  })

  test('ctx.effect coexists with a directive on the same host; both reactive, both dispose on unmount', async () => {
    const win = setupDom('<div id="host"><div x-data="fx4"><span x-text="msg"></span></div></div>')
    const { register, start } = await import(`./runtime.ts?fx4=${Math.random()}`)
    const { signal } = await import('../store/index.ts')
    const msg = signal('a')
    const effectRuns: string[] = []
    let torn = false
    register('fx4', ({ effect }: any) => {
      effect(() => {
        effectRuns.push(msg())
        return () => {
          torn = true
        }
      })
      return { msg }
    })
    start(win.document)
    const span = win.document.querySelector('span')!
    expect(span.textContent).toBe('a') // directive bound
    expect(effectRuns).toEqual(['a']) // ctx effect ran, tracking the same signal
    msg.set('b')
    expect(span.textContent).toBe('b') // directive reactive
    expect(effectRuns).toEqual(['a', 'b']) // ctx effect reactive
    win.document.getElementById('host')!.innerHTML = '' // unmount → dispose both
    await Promise.resolve()
    expect(torn).toBe(true) // ctx effect cleanup ran
    msg.set('c')
    expect(span.textContent).toBe('b') // directive disposed too (no detached update)
    expect(effectRuns).toEqual(['a', 'b']) // ctx effect disposed too (no detached run)
  })

  test('ctx.onCleanup registers a teardown that runs on unmount', async () => {
    const win = setupDom('<div id="host"><div x-data="fx3"></div></div>')
    const { register, start } = await import(`./runtime.ts?fx3=${Math.random()}`)
    let torn = 0
    register('fx3', ({ onCleanup }: any) => {
      onCleanup(() => {
        torn++
      })
      return {}
    })
    start(win.document)
    expect(torn).toBe(0)
    win.document.getElementById('host')!.innerHTML = ''
    await Promise.resolve()
    expect(torn).toBe(1)
  })
})
