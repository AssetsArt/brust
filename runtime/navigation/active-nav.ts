// runtime/navigation/active-nav.ts
// The DOM consumer of the navigation store. Installs two effects:
//  - nav.path  → reconcile is-active/aria-current on links in [data-brust-active-nav]
//  - nav.phase → mirror to <html data-brust-nav> for CSS-driven indicators
// Attribute name [data-brust-active-nav] is deliberately distinct from the
// <html data-brust-nav> phase attr so the reconciler never treats <html> as a
// container (which would toggle is-active on every <a> in the document).
import { effect } from '../store/signal.ts'
import { nav, type NavPhase } from './store.ts'

// The install guard lives on globalThis (like __BRUST_NAV__), NOT as a module
// `let`: every Bun.build island chunk inlines its own copy of this module, so a
// module-local flag would not stop a second chunk from installing a duplicate
// pair of effects (both resolve the same singleton signals → double reconcile).
interface ActiveNavState {
  installed: boolean
  disposers: Array<() => void>
}
const GA = globalThis as { __BRUST_ACTIVE_NAV__?: ActiveNavState }
function activeNavState(): ActiveNavState {
  if (!GA.__BRUST_ACTIVE_NAV__) GA.__BRUST_ACTIVE_NAV__ = { installed: false, disposers: [] }
  return GA.__BRUST_ACTIVE_NAV__
}

export function installActiveNav(): void {
  const a = activeNavState()
  if (a.installed) return
  a.installed = true
  // effect() runs eagerly once and re-runs whenever a signal it read changes;
  // it returns a disposer we keep so __resetActiveNavForTest can unsubscribe.
  a.disposers = [
    effect(() => {
      const path = nav.path()
      reconcileActiveLinks(path)
    }),
    effect(() => {
      const phase = nav.phase()
      setHtmlNav(phase)
    }),
  ]
}

function setHtmlNav(phase: NavPhase): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  // 'success' is a transient logical phase; the DOM attr returns to idle so
  // loading indicators clear once committed.
  document.documentElement.setAttribute('data-brust-nav', phase === 'success' ? 'idle' : phase)
}

function reconcileActiveLinks(currentPath: string): void {
  if (typeof document === 'undefined') return
  const containers = document.querySelectorAll<HTMLElement>('[data-brust-active-nav]')
  for (const el of Array.from(containers)) {
    const activeClass = el.dataset.brustActiveClass || 'is-active'
    const prefix = el.dataset.brustActiveMatch === 'prefix'
    const links = el.querySelectorAll<HTMLAnchorElement>('a[href]')
    for (const a of Array.from(links)) {
      const linkPath = new URL(a.href, location.href).pathname
      const isActive = prefix
        ? currentPath === linkPath || currentPath.startsWith(`${linkPath.replace(/\/$/, '')}/`)
        : currentPath === linkPath
      a.classList.toggle(activeClass, isActive)
      if (isActive) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    }
  }
}

// Test-only: dispose the installed effects and clear the guard so a subsequent
// installActiveNav() rebinds to the fresh singleton (after __resetNavForTest).
export function __resetActiveNavForTest(): void {
  const a = activeNavState()
  for (const d of a.disposers) d()
  GA.__BRUST_ACTIVE_NAV__ = undefined
}
