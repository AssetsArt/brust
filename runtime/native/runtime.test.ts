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
