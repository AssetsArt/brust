// runtime/navigation/active-nav.test.ts
import { test, expect, beforeAll, beforeEach } from 'bun:test'
import { Window } from 'happy-dom'

let installActiveNav: () => void
let __resetActiveNavForTest: () => void
let __navInit: typeof import('./store.ts').__navInit
let __navCommit: typeof import('./store.ts').__navCommit
let __resetNavForTest: typeof import('./store.ts').__resetNavForTest

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/' })
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError = TypeError
  Object.assign(globalThis, {
    document: win.document,
    window: win,
    location: win.location,
    HTMLElement: win.HTMLElement,
    HTMLAnchorElement: (win as unknown as Record<string, unknown>).HTMLAnchorElement,
    URL,
  })
  const store = await import('./store.ts')
  __navInit = store.__navInit
  __navCommit = store.__navCommit
  __resetNavForTest = store.__resetNavForTest
  const an = await import('./active-nav.ts')
  installActiveNav = an.installActiveNav
  __resetActiveNavForTest = an.__resetActiveNavForTest
})

beforeEach(() => {
  __resetNavForTest()
  __resetActiveNavForTest()
  document.documentElement.removeAttribute('data-brust-nav')
  document.body.innerHTML = ''
})

function navMarkup(html: string) {
  document.body.innerHTML = `<nav data-brust-active-nav>${html}</nav>`
}

test('reconciles is-active + aria-current onto the matching link on init', () => {
  navMarkup('<a href="/">Home</a><a href="/type-chart">Chart</a>')
  __navInit('/type-chart', '')
  installActiveNav()
  const links = document.querySelectorAll('a')
  expect(links[0].classList.contains('is-active')).toBe(false)
  expect(links[1].classList.contains('is-active')).toBe(true)
  expect(links[1].getAttribute('aria-current')).toBe('page')
  expect(links[0].getAttribute('aria-current')).toBe(null)
})

test('re-reconciles on committed path change', () => {
  navMarkup('<a href="/">Home</a><a href="/type-chart">Chart</a>')
  __navInit('/', '')
  installActiveNav()
  expect(document.querySelectorAll('a')[0].classList.contains('is-active')).toBe(true)
  __navCommit('/type-chart', '')
  const links = document.querySelectorAll('a')
  expect(links[0].classList.contains('is-active')).toBe(false)
  expect(links[1].classList.contains('is-active')).toBe(true)
})

test('data-brust-active-class overrides the active class', () => {
  document.body.innerHTML =
    '<nav data-brust-active-nav data-brust-active-class="on"><a href="/x">X</a></nav>'
  __navInit('/x', '')
  installActiveNav()
  expect(document.querySelector('a')!.classList.contains('on')).toBe(true)
})

test('prefix match activates a parent link for a nested path', () => {
  document.body.innerHTML =
    '<nav data-brust-active-nav data-brust-active-match="prefix"><a href="/docs">Docs</a></nav>'
  __navInit('/docs/intro', '')
  installActiveNav()
  expect(document.querySelector('a')!.classList.contains('is-active')).toBe(true)
})

test('html[data-brust-nav] mirrors phase, success maps to idle', () => {
  navMarkup('<a href="/">Home</a>')
  __navInit('/', '')
  installActiveNav()
  expect(document.documentElement.getAttribute('data-brust-nav')).toBe('idle')
  __navCommit('/', '') // phase=success
  expect(document.documentElement.getAttribute('data-brust-nav')).toBe('idle')
})

test('<html data-brust-nav> is NOT treated as an active-nav container', () => {
  document.documentElement.setAttribute('data-brust-nav', 'loading')
  document.body.innerHTML = '<a href="/should-not-activate">x</a>' // no container
  __navInit('/should-not-activate', '')
  installActiveNav()
  // link is outside any [data-brust-active-nav] container → untouched
  expect(document.querySelector('a')!.classList.contains('is-active')).toBe(false)
})
