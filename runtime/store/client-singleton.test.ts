import { beforeAll, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let defineStore: typeof import('./define-store.ts').defineStore
let signal: typeof import('./signal.ts').signal
let computed: typeof import('./signal.ts').computed

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/' })
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError = TypeError
  Object.assign(globalThis, {
    document: win.document,
    window: win,
  })
  ;({ signal, computed } = await import('./signal.ts'))
  ;({ defineStore } = await import('./define-store.ts'))
})

test('two distinct defineStore handles share the same window registry instance', () => {
  const make = () =>
    defineStore('counter', () => {
      const n = signal(0)
      return {
        n,
        inc() {
          n.set((v) => v + 1)
        },
      }
    })
  const a = make()
  const b = make()
  let aFired = 0
  a.subscribe(() => {
    aFired++
  })
  b.inc()
  // handle A's subscriber fires when handle B writes → same underlying instance
  expect(aFired).toBe(1)
  expect(a.n()).toBe(1)
  expect(b.n()).toBe(1)
})

test('first client access hydrates from injected <script data-brust-store>', () => {
  const el = document.createElement('script')
  el.setAttribute('type', 'application/json')
  el.setAttribute('data-brust-store', 'profile')
  el.textContent = JSON.stringify({ handle: 'ash' })
  document.head.appendChild(el)

  const profile = defineStore('profile', () => {
    const handleName = signal('')
    const upper = computed(() => handleName().toUpperCase())
    return { handle: handleName, upper }
  })
  expect(profile.handle()).toBe('ash')
  expect(profile.snapshot().upper).toBe('ASH')
})
