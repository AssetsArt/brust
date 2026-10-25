// The built-in `navigation` store (design docs/design/2026-10-25-spa-navigation-design.md §11): the `brust:nav:*` events as
// signals, so a component reads navigation state through `useStore(navigation)` like any other store. Browser-safe and
// React-free, like `@brust/core/store`. The name is reserved (the compiler refuses a user `defineStore('navigation')`).
//
// Server: the factory paints `idle` and the loader seeds `url` with the request's path + search (handlers.ts), so the first
// paint is right and hydration matches. Browser: this module listens to the four events once and `batch`-sets the signals.
import { batch, defineStore, signal } from '@brust/runtime-dom/store'

export type NavigationTrigger = 'link' | 'navigate' | 'popstate'

const at = (): string => (typeof location === 'undefined' ? '/' : location.pathname + location.search)

/** `new URL(href).pathname + search`, the way the store spells a page; `href` itself when it does not parse. */
const path = (href: unknown): string => {
  try {
    const u = new URL(String(href), typeof location === 'undefined' ? 'http://x' : location.href)
    return u.pathname + u.search
  } catch {
    return String(href)
  }
}

export const navigation = defineStore('navigation', () => ({
  /** `'loading'` from `brust:nav:load` until `success` / `error`. */
  state: signal<'idle' | 'loading'>('idle'),
  /** Path + search of the page on screen: updated at `success`, and at `error` when the page was swapped in. */
  url: signal<string>(at()),
  /** Path + search being loaded, else `null`. */
  to: signal<string | null>(null),
  /** Of the current or last navigation. */
  trigger: signal<NavigationTrigger | null>(null),
  /** HTTP status of the last navigation. */
  status: signal<number | null>(null),
  /** Message of the last failed navigation; cleared at the next `load`. */
  error: signal<string | null>(null),
  /** The last navigation id (0 before any). */
  id: signal<number>(0),
}))

// One subscription per tab, whichever chunk evaluates this module first (the store registry is shared the same way).
const BOUND = Symbol.for('brust.navigation')
if (typeof document !== 'undefined' && !(globalThis as { [BOUND]?: true })[BOUND]) {
  ;(globalThis as { [BOUND]?: true })[BOUND] = true
  const on = (name: string, apply: (d: Record<string, unknown>) => void) =>
    document.addEventListener(`brust:nav:${name}`, (e) => apply((e as CustomEvent).detail ?? {}))
  on('load', (d) =>
    batch(() => {
      navigation.state.set('loading')
      navigation.to.set(path(d.url))
      navigation.trigger.set(d.trigger as NavigationTrigger)
      navigation.error.set(null)
      navigation.id.set(d.id as number)
    }),
  )
  on('success', (d) =>
    batch(() => {
      navigation.state.set('idle')
      navigation.url.set(path(d.url))
      navigation.to.set(null)
      navigation.trigger.set(d.trigger as NavigationTrigger)
      navigation.status.set(d.status as number)
      navigation.error.set(null)
      navigation.id.set(d.id as number)
    }),
  )
  on('error', (d) =>
    batch(() => {
      navigation.state.set('idle')
      // A swapped error page (404, 500) is on screen; a failed swap leaves the old page where it was.
      if (d.swapped) navigation.url.set(path(d.url))
      navigation.to.set(null)
      navigation.trigger.set(d.trigger as NavigationTrigger)
      navigation.status.set((d.status as number | undefined) || null) // 0: no response
      navigation.error.set(d.error instanceof Error ? d.error.message : d.error != null ? String(d.error) : `HTTP ${d.status}`)
      navigation.id.set(d.id as number)
    }),
  )
}
