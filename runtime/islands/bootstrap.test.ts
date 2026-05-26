// DOM is not available in bun's default environment. We install happy-dom
// globals in beforeAll so this file is self-contained (no --preload needed).
import { test, expect, beforeAll } from 'bun:test'
import { Window } from 'happy-dom'

// isInternalLink and hydrateMarkersIn are imported lazily (after DOM is up)
// via a module-level variable populated in beforeAll.
let isInternalLink: (a: HTMLAnchorElement, e: MouseEvent) => boolean
let hydrateMarkersIn: (root?: ParentNode) => void

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/' })
  // happy-dom 20.9.0 leaves win.SyntaxError/TypeError undefined, which
  // crashes its own querySelectorAll :not() implementation. Patch them.
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError  = TypeError

  Object.assign(globalThis, {
    document:          win.document,
    window:            win,
    location:          win.location,
    history:           win.history,
    MouseEvent:        win.MouseEvent,
    Event:             win.Event,
    HTMLElement:       win.HTMLElement,
    HTMLAnchorElement: (win as unknown as Record<string, unknown>).HTMLAnchorElement,
    // IntersectionObserver intentionally absent — registerTrigger guards with typeof check
    // AbortController is provided natively by bun
  })

  // Import after globals are set so bootstrap's module-level guard
  // (typeof document !== 'undefined') sees the DOM correctly.
  const mod = await import('./bootstrap')
  isInternalLink  = mod.isInternalLink
  hydrateMarkersIn = mod.hydrateMarkersIn
})

function makeLink(href: string, attrs: Partial<{ target: string; download: string; 'data-brust-no-intercept': string }> = {}): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = href
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) a.setAttribute(k, v)
  }
  return a
}

function plainClick(): MouseEvent {
  return new MouseEvent('click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })
}

test('isInternalLink accepts plain same-origin <a href> on left click with no modifiers', () => {
  const a = makeLink('/blog/welcome')
  expect(isInternalLink(a, plainClick())).toBe(true)
})

test('isInternalLink rejects external origin, _blank, modifier-click, anchor, /_brust/, opt-out, download', () => {
  expect(isInternalLink(makeLink('https://example.com/x'), plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/x', { target: '_blank' }), plainClick())).toBe(false)
  const a = makeLink('/x')
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, metaKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, ctrlKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, shiftKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, altKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 1 }))).toBe(false)
  const anchor = makeLink(`${location.origin}${location.pathname}#section`)
  expect(isInternalLink(anchor, plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/_brust/page/x'), plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/x', { 'data-brust-no-intercept': '' }), plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/file.pdf', { download: '' }), plainClick())).toBe(false)
})

test('hydrateMarkersIn(root) only scans within the given root subtree', () => {
  const outside = document.createElement('div')
  outside.setAttribute('data-brust-island', 'Outside')
  outside.setAttribute('data-brust-props', '{}')
  document.body.appendChild(outside)

  const root = document.createElement('div')
  document.body.appendChild(root)
  const inside = document.createElement('div')
  inside.setAttribute('data-brust-island', 'Inside')
  inside.setAttribute('data-brust-props', '{}')
  root.appendChild(inside)

  try {
    hydrateMarkersIn(root)
    expect(inside.hasAttribute('data-brust-hydrated')).toBe(true)
    expect(outside.hasAttribute('data-brust-hydrated')).toBe(false)
  } finally {
    document.body.removeChild(outside)
    document.body.removeChild(root)
  }
})

test('hydrateMarkersIn is idempotent — second call on same root does not re-tag', () => {
  const root = document.createElement('div')
  const marker = document.createElement('div')
  marker.setAttribute('data-brust-island', 'X')
  marker.setAttribute('data-brust-props', '{}')
  root.appendChild(marker)
  document.body.appendChild(root)

  try {
    hydrateMarkersIn(root)
    expect(marker.getAttribute('data-brust-hydrated')).toBe('1')

    marker.setAttribute('data-brust-hydrated', 'seen')
    hydrateMarkersIn(root)
    expect(marker.getAttribute('data-brust-hydrated')).toBe('seen')
  } finally {
    document.body.removeChild(root)
  }
})
