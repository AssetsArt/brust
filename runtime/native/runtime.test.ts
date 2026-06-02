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
    const { signal, computed } = await import('brustjs/store')
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
    const { signal } = await import('brustjs/store')
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
    const { signal } = await import('brustjs/store')
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
    const { signal } = await import('brustjs/store')
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
