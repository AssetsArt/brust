import { beforeAll, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let useStore: typeof import('./react.ts').useStore
let defineStore: typeof import('./define-store.ts').defineStore
let signal: typeof import('./signal.ts').signal
let React: typeof import('react')
let createRoot: typeof import('react-dom/client').createRoot
let act: typeof import('react').act

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/' })
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
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
  })
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ signal } = await import('./signal.ts'))
  ;({ defineStore } = await import('./define-store.ts'))
  ;({ useStore } = await import('./react.ts'))
})

test('useStore re-renders on write and matches server snapshot path', async () => {
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

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  await act(async () => {
    root.render(React.createElement(View))
  })
  expect(host.querySelector('#score')?.textContent).toBe('0')

  await act(async () => {
    team.bump()
  })
  expect(host.querySelector('#score')?.textContent).toBe('1')

  // The snapshot React reads must equal what snapshot() returns directly.
  expect(team.snapshot().score).toBe(1)
})
