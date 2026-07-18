import { beforeAll, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let createBrustRuntime: typeof import('./index.ts').createBrustRuntime

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/' })
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError = TypeError
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    history: win.history,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    Event: win.Event,
    InputEvent: win.InputEvent,
    MouseEvent: win.MouseEvent,
    FocusEvent: win.FocusEvent,
    KeyboardEvent: win.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  })
  createBrustRuntime = (await import('./index.ts')).createBrustRuntime
})

test('assembles the P1 runtime and stable P2 disabled stubs', async () => {
  const runtime = createBrustRuntime()
  expect(runtime.version).toEqual({ api: 1, brust: '0.1.64-alpha' })
  expect(Object.keys(runtime.action)).toEqual([
    'click',
    'focus',
    'blur',
    'fill',
    'form',
    'press',
    'select',
    'check',
  ])
  expect(await runtime.wait()).toEqual({
    ok: false,
    error: { code: 'disabled', message: 'P2' },
  })
})

test('public wrappers resolve malformed calls as envelopes instead of rejecting', async () => {
  const runtime = createBrustRuntime()
  await expect(runtime.struct({ within: '[' })).resolves.toMatchObject({
    ok: false,
    error: { code: 'bad-input' },
  })
  await expect(runtime.action.fill('body', Symbol('bad'))).resolves.toMatchObject({
    ok: false,
    error: { code: 'bad-input' },
  })
})
