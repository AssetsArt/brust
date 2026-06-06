// NATIVE INTERACTIVE COMPONENT — dark/light toggle. Dogfoods the ctx `effect()`:
// a reactive effect syncs the `mode` signal onto <html data-mode> AND localStorage,
// so the toggle handler only flips the signal. Single-file behavior → "themeToggle"
// chunk. Icons are sibling spans toggled by x-show (x-text can't host an SSR icon).
import { Moon, Sun } from 'lucide-react'
import { computed, signal } from 'brustjs/store'
import type { BehaviorCtx } from 'brustjs/native'

export const behavior = ({ effect }: BehaviorCtx) => {
  const initial =
    typeof document !== 'undefined'
      ? (localStorage.getItem('mode') ?? document.documentElement.dataset.mode ?? 'dark')
      : 'dark'
  const mode = signal(initial)
  const isDark = computed(() => mode() === 'dark')
  const isLight = computed(() => mode() === 'light')

  // reactive sync: mode → <html data-mode> + persisted to localStorage.
  effect(() => {
    document.documentElement.dataset.mode = mode()
    localStorage.setItem('mode', mode())
  })

  const toggle = () => mode.set(mode() === 'dark' ? 'light' : 'dark')
  return { toggle, isDark, isLight }
}

export default function ThemeToggle() {
  return (
    <button
      type="button"
      x-on-click="toggle"
      aria-label="Toggle theme"
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <span x-show="isDark" className="theme-icon-dark inline-flex">
        <Sun size={16} />
      </span>
      <span x-show="isLight" className="theme-icon-light inline-flex">
        <Moon size={16} />
      </span>
    </button>
  )
}
