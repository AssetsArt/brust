// Preload shim — installs happy-dom globals before bootstrap.test.ts runs.
// Used via: bun test --preload ./runtime/islands/test-dom-setup.ts
//
// Note: happy-dom 20.9.0 leaves win.SyntaxError / win.TypeError undefined,
// which crashes its own querySelectorAll :not() path. We patch them before
// any test code touches the DOM.
import { Window } from 'happy-dom'

const win = new Window({ url: 'http://localhost/' })

// Patch missing built-ins that happy-dom's selector engine requires.
;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
;(win as unknown as Record<string, unknown>).TypeError  = TypeError

// Populate every global the tests and bootstrap module touch.
Object.assign(globalThis, {
  document:          win.document,
  window:            win,
  location:          win.location,
  history:           win.history,
  HTMLElement:       win.HTMLElement,
  HTMLAnchorElement: (win as unknown as Record<string, unknown>).HTMLAnchorElement,
  MouseEvent:        win.MouseEvent,
  Event:             win.Event,
  // IntersectionObserver intentionally absent — registerTrigger guards with typeof check
  // AbortController is provided natively by bun
})
