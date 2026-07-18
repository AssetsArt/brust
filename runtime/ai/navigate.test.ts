import { beforeAll, beforeEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import {
  __navCommit,
  __navInit,
  __navStart,
  __resetNavForTest,
  registerNavigator,
} from '../navigation/store.ts'
import { navigate } from './navigate.ts'

beforeAll(() => {
  const win = new Window({ url: 'http://localhost/start' })
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
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  })
})

beforeEach(() => {
  __resetNavForTest()
  __navInit('/start', '')
  document.body.innerHTML = ''
})

test('navigate accepts success as terminal and can return a fresh struct', async () => {
  registerNavigator(async (url) => {
    __navStart(url.pathname, url.search)
    history.pushState({}, '', url.href)
    document.body.innerHTML = '<main><h1>Destination</h1></main>'
    __navCommit(url.pathname, url.search)
  })
  const response = await navigate('/destination', { struct: true })
  expect(response).toMatchObject({
    ok: true,
    status: 'spa',
    struct: { path: '/destination', outline: [{ level: 1, text: 'Destination' }] },
  })
})

test('navigate maps a terminal error to nav-failed', async () => {
  registerNavigator(async (url) => {
    __navStart(url.pathname, url.search)
    const store = await import('../navigation/store.ts')
    store.__navError(url.pathname, new Error('network down'))
  })
  expect(await navigate('/broken')).toMatchObject({
    ok: false,
    error: { code: 'nav-failed', message: 'network down' },
  })
})

test('navigate reports the destination before scheduling an unbootstrapped full load', async () => {
  __resetNavForTest()
  __navInit('/start', '')
  const response = await navigate('/full-document')
  expect(response).toMatchObject({
    ok: true,
    status: 'full-load',
    url: 'http://localhost/full-document',
  })
})

// Regression (integration-found): hidden/background tabs pause rAF entirely —
// the exact environment agent-driven browsers run in. A bare rAF await made
// every successful action settle hang forever (conclave in-app browser,
// 2026-07-18). settle must resolve via the timer fallback when rAF never fires.
test('settleAfterAction resolves even when requestAnimationFrame never fires', async () => {
  const realRaf = globalThis.requestAnimationFrame
  Object.assign(globalThis, { requestAnimationFrame: () => 0 })
  try {
    const { settleAfterAction } = await import('./navigate.ts')
    const started = performance.now()
    expect(await settleAfterAction(1_000)).toBeNull()
    expect(performance.now() - started).toBeLessThan(500)
  } finally {
    Object.assign(globalThis, { requestAnimationFrame: realRaf })
  }
})
