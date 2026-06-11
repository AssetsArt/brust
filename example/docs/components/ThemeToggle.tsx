// NATIVE theme toggle — `data-theme` on <html> + localStorage persistence
// (key `brust-docs-theme`). Deliberately REPLACES pokedex's cookie/action
// mechanism: cookies need a server and this site deploys static. The
// pre-paint FOUC script (BrustPage `head` in BOTH shells — Home and
// DocsLayout) stamps `data-theme` from localStorage before first paint; this
// behavior only flips + persists afterwards. Default (nothing stored) = dark,
// the :root default in app.css — no attribute needed.
//
// Icon swap is pure CSS off html[data-theme] (app.css `.theme-icon-*`
// rules), so the right icon shows even BEFORE the behavior mounts — no
// flash, no x-show needed. Sun shows in dark ("switch to light"), Moon in
// light.
import { Moon, Sun } from 'lucide-react'
import type { BehaviorCtx } from 'brustjs/native'
import { signal } from 'brustjs/store'

const STORAGE_KEY = 'brust-docs-theme'

// behavior → client bundle (registered "themeToggle"). Initial value comes
// straight off <html> — the head script already applied any stored theme.
export const behavior = ({ effect }: BehaviorCtx) => {
  const theme = signal(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

  // reflect the signal onto <html>; the CSS icon swap follows the attribute
  // (ctx effect — auto-disposed on unmount/SPA-nav)
  effect(() => {
    document.documentElement.dataset.theme = theme()
  })

  function toggle() {
    const next = theme() === 'light' ? 'dark' : 'light'
    theme.set(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // storage unavailable (private mode) — the theme still flips for this page
    }
  }

  return { toggle }
}

// default → jinja (server). currentColor styling so the same component works
// on the dark glass pill (Home) and the theme-colored docs header. 40px hit
// area (DESIGN.md minimum).
export default function ThemeToggle() {
  return (
    <button
      type="button"
      x-on-click="toggle"
      aria-label="Toggle theme"
      className="inline-flex h-10 w-10 items-center justify-center rounded-full text-current transition-colors duration-150 hover:bg-current/10"
    >
      <span className="theme-icon-dark inline-flex">
        <Sun size={16} />
      </span>
      <span className="theme-icon-light inline-flex">
        <Moon size={16} />
      </span>
    </button>
  )
}
