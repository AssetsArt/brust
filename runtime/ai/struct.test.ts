import { beforeAll, beforeEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { __navInit, __resetNavForTest } from '../navigation/store.ts'
import { __resetRefsForTest } from './refs.ts'
import { struct } from './struct.ts'

beforeAll(() => {
  const win = new Window({ url: 'http://localhost/current' })
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError = TypeError
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLHeadingElement: win.HTMLHeadingElement,
  })
})

beforeEach(() => {
  __resetRefsForTest()
  __resetNavForTest()
  __navInit('/current', '')
  document.head.innerHTML = '<title>Current</title><meta name="brust-shell" content="shell-a">'
  document.body.innerHTML = ''
})

test('extracts framework-aware structure, names forms, and redacts values', async () => {
  document.body.innerHTML = `
    <h1>  Page   title  </h1>
    <a href="/current" aria-current="page">Here</a>
    <a href="https://example.com/x">Away</a>
    <span x-on-click="open">Open dialog</span>
    <form data-ai-name="login" action="/login" method="post">
      <input name="email" value="a@example.com" required>
      <input name="password" type="password" value="secret">
      <input name="token" value="hidden" data-ai-redact>
      <select name="role"><option value="admin">Administrator</option></select>
      <button>Submit</button>
    </form>
    <input x-model="query" value="pikachu">
    <section data-brust-island="Counter" data-brust-hydrated></section>
    <div x-data="menu"></div>
    <section data-ai-ignore><button>Invisible</button><h2>Hidden</h2></section>
  `
  const snapshot = await struct()
  if ('ok' in snapshot) throw new Error('unexpected struct error')
  expect(snapshot.shellId).toBe('shell-a')
  expect(snapshot.outline).toEqual([{ level: 1, text: 'Page title' }])
  expect(snapshot.links.map(({ external, current }) => ({ external, current }))).toEqual([
    { external: false, current: true },
    { external: true, current: false },
  ])
  expect(snapshot.buttons).toHaveLength(2)
  expect(snapshot.buttons[0]).toMatchObject({ text: 'Open dialog', kind: 'x-on-click' })
  expect(snapshot.buttons[1]).toMatchObject({ text: 'Submit', kind: 'submit' })
  expect(snapshot.forms[0]?.name).toBe('login')
  expect(snapshot.forms[0]?.fields.map((field) => field.value)).toEqual([
    'a@example.com',
    null,
    null,
    'admin',
  ])
  expect(snapshot.inputs[0]).toMatchObject({ name: 'query', value: 'pikachu' })
  expect(snapshot.islands[0]).toMatchObject({ name: 'Counter', hydrated: true })
  expect(snapshot.behaviors[0]?.name).toBe('menu')
})

test('within scopes traversal and maxText truncates labels', async () => {
  document.body.innerHTML =
    '<main id="scope"><button>abcdefgh</button></main><button>outside</button>'
  const snapshot = await struct({ within: '#scope', maxText: 4 })
  if ('ok' in snapshot) throw new Error('unexpected struct error')
  expect(snapshot.buttons).toHaveLength(1)
  expect(snapshot.buttons[0]?.text).toBe('abcd')
})
