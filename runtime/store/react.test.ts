import { beforeAll, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
// NOTE: we deliberately do NOT use react-dom/client here. islands/bootstrap.test.ts
// calls mock.module('react-dom/client', …) and bun's mock.module leaks
// process-wide (mock.restore() does NOT undo it — see memory
// bun-mock-module-leaks-suite), so a full-suite run hands this file a mocked
// createRoot whose render() is a no-op → nothing mounts. We assert useStore via
// renderToString (react-dom/server.node, NOT mocked) which exercises
// useSyncExternalStore's server-snapshot path. The client subscribe→re-render path
// is covered by client-singleton.test.ts (cross-handle sync without React).
//
// A global `window` is required so defineStore takes its CLIENT branch (a window
// singleton); without it the store resolves to the server branch and throws
// "outside a request scope" when run in isolation. We reuse an existing global
// document if a sibling happy-dom suite already installed one (react-dom binds to
// the first global document process-wide), else create our own — so the test is
// deterministic both alone and in a full-suite run.

let useStore: typeof import('./react.ts').useStore
let defineStore: typeof import('./define-store.ts').defineStore
let signal: typeof import('./signal.ts').signal
let React: typeof import('react')
let renderToString: typeof import('react-dom/server.node').renderToString

beforeAll(async () => {
  if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
    const win = new Window({ url: 'http://localhost/' })
    // happy-dom's querySelector references win.SyntaxError on a bad selector;
    // it is undefined on a bare Window, so wire the host realm's globals.
    ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
    ;(win as unknown as Record<string, unknown>).TypeError = TypeError
    Object.assign(globalThis, {
      document: win.document,
      window: win,
      navigator: win.navigator,
      HTMLElement: win.HTMLElement,
      Element: win.Element,
      Node: win.Node,
      Event: win.Event,
    })
  }
  React = await import('react')
  ;({ renderToString } = await import('react-dom/server.node'))
  ;({ signal } = await import('./signal.ts'))
  ;({ defineStore } = await import('./define-store.ts'))
  ;({ useStore } = await import('./react.ts'))
})

test('useStore renders the store snapshot and reflects writes; server snapshot matches', () => {
  const team = defineStore('rt-team', () => {
    const score = signal(0)
    return {
      score,
      bump() {
        score.set((v) => v + 1)
      },
    }
  })

  function View() {
    const snap = useStore(team)
    return React.createElement('span', { id: 'score' }, String(snap.score))
  }

  // Initial render — useSyncExternalStore reads getServerSnapshot (3rd arg = snapshot).
  expect(renderToString(React.createElement(View))).toContain('>0</span>')
  expect(team.snapshot().score).toBe(0)

  // A write is observed by the next render, and the snapshot React reads equals
  // what snapshot() returns directly (no divergence between the two paths).
  team.bump()
  expect(renderToString(React.createElement(View))).toContain('>1</span>')
  expect(team.snapshot().score).toBe(1)
})
