// components/ThemeToggle.tsx — useState + useEffect (spec §9 example). No cookie write (actions are M3): the
// loader still reads `mode` from the cookie for the first paint; the toggle is per page view.
import { useEffect, useState } from 'react'
export default function ThemeToggle(props: { mode: 'dark' | 'light' }) {
  const [mode, setMode] = useState(props.mode)
  useEffect(() => { document.documentElement.dataset.mode = mode }, [mode])
  return (
    <button type="button" aria-label="Toggle theme" data-testid="theme-toggle" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium dark:border-slate-700">
      {mode === 'dark' ? 'Light' : 'Dark'}
    </button>
  )
}
