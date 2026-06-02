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
