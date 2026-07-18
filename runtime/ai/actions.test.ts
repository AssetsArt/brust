import { beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { __navInit, __resetNavForTest } from '../navigation/store.ts'
import { check, click, fill, focus, form, press, select } from './actions.ts'
import { __resetRefsForTest } from './refs.ts'

beforeAll(() => {
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
    HTMLFormElement: win.HTMLFormElement,
    Event: win.Event,
    InputEvent: win.InputEvent,
    MouseEvent: win.MouseEvent,
    FocusEvent: win.FocusEvent,
    KeyboardEvent: win.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  })
})

beforeEach(() => {
  document.body.innerHTML = ''
  __resetRefsForTest()
  __resetNavForTest()
  __navInit('/', '')
})

test('fill uses the native prototype setter and dispatches bubbling input/change', async () => {
  const input = document.createElement('input')
  document.body.append(input)
  const ownSetter = mock(() => {})
  Object.defineProperty(input, 'value', { configurable: true, set: ownSetter })
  const seen: string[] = []
  input.addEventListener('input', (event) => seen.push(`${event.type}:${event.bubbles}`))
  input.addEventListener('change', (event) => seen.push(`${event.type}:${event.bubbles}`))
  const response = await fill('input', 'controlled')
  expect(response).toMatchObject({ ok: true, navigated: false })
  expect(ownSetter).not.toHaveBeenCalled()
  expect(
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(input),
  ).toBe('controlled')
  expect(seen).toEqual(['input:true', 'change:true'])
})

test('form fills named fields with native events then requestSubmits', async () => {
  document.body.innerHTML = `
    <form data-ai-name="profile">
      <input name="name">
      <select name="role"><option value="user">User</option><option value="admin">Admin</option></select>
    </form>`
  const formElement = document.querySelector('form')!
  const submitted = mock(() => {})
  formElement.requestSubmit = submitted
  const response = await form('profile', { name: 'Ada', role: 'admin' })
  expect(response).toMatchObject({ ok: true })
  expect((formElement.elements.namedItem('name') as HTMLInputElement).value).toBe('Ada')
  expect((formElement.elements.namedItem('role') as HTMLSelectElement).value).toBe('admin')
  expect(submitted).toHaveBeenCalledTimes(1)
})

test('form rejects an unknown key and lists available names', async () => {
  document.body.innerHTML = '<form id="f"><input name="known"></form>'
  expect(await form('f', { missing: 'x' })).toMatchObject({
    ok: false,
    error: { code: 'bad-input', hint: 'available fields: known' },
  })
})

test('form accepts a CSS selector as its target', async () => {
  document.body.innerHTML = '<form id="settings"><input name="theme"></form>'
  const formElement = document.querySelector('form')!
  formElement.requestSubmit = mock(() => {})
  expect(await form('#settings', { theme: 'dark' })).toMatchObject({ ok: true })
})

test('an action returns console errors emitted by its handlers', async () => {
  document.body.innerHTML = '<input>'
  document.querySelector('input')!.addEventListener('input', () => console.error('handler failed'))
  const response = await fill('input', 'x')
  expect(response).toMatchObject({ ok: true, errors: [{ message: 'handler failed' }] })
})

test('click dispatches the cancelable pointer sequence in order', async () => {
  document.body.innerHTML = '<button>Go</button>'
  const seen: Array<{ type: string; bubbles: boolean; cancelable: boolean }> = []
  const button = document.querySelector('button')!
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    button.addEventListener(type, (event) =>
      seen.push({ type: event.type, bubbles: event.bubbles, cancelable: event.cancelable }),
    )
  }
  expect(await click('button')).toMatchObject({ ok: true })
  expect(seen).toEqual([
    { type: 'pointerdown', bubbles: true, cancelable: true },
    { type: 'pointerup', bubbles: true, cancelable: true },
    { type: 'click', bubbles: true, cancelable: true },
  ])
})

test('press dispatches keydown, keypress, and keyup with the requested key', async () => {
  document.body.innerHTML = '<input>'
  const seen: string[] = []
  const input = document.querySelector('input')!
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.addEventListener(type, (event) =>
      seen.push(`${event.type}:${(event as KeyboardEvent).key}`),
    )
  }
  expect(await press('input', 'Enter')).toMatchObject({ ok: true })
  expect(seen).toEqual(['keydown:Enter', 'keypress:Enter', 'keyup:Enter'])
})

test('select resolves a label and dispatches input/change', async () => {
  document.body.innerHTML =
    '<select><option value="water">Water</option><option value="fire">Fire</option></select>'
  const selectElement = document.querySelector('select')!
  const seen: string[] = []
  selectElement.addEventListener('input', (event) => seen.push(event.type))
  selectElement.addEventListener('change', (event) => seen.push(event.type))
  expect(await select('select', 'Fire')).toMatchObject({ ok: true })
  expect(selectElement.value).toBe('fire')
  expect(seen).toEqual(['input', 'change'])
})

test('check uses the native checked setter and dispatches input/change', async () => {
  document.body.innerHTML = '<input type="checkbox">'
  const input = document.querySelector('input')!
  const seen: string[] = []
  input.addEventListener('input', (event) => seen.push(event.type))
  input.addEventListener('change', (event) => seen.push(event.type))
  expect(await check('input', true)).toMatchObject({ ok: true })
  expect(input.checked).toBe(true)
  expect(seen).toEqual(['input', 'change'])
})

test('focus moves document focus through the native focus method', async () => {
  document.body.innerHTML = '<input>'
  const input = document.querySelector('input')!
  expect(await focus('input')).toMatchObject({ ok: true })
  expect(document.activeElement).toBe(input)
})
