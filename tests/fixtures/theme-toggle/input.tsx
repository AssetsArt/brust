import { useState, useEffect } from 'react'

export default function ThemeToggle({ themeLabel }: { themeLabel: string }) {
  const [mode, setMode] = useState('dark')
  const label = mode === 'dark' ? 'Light' : 'Dark'

  useEffect(() => {
    document.documentElement.dataset.mode = mode
  }, [mode])

  return (
    <button type="button" aria-label={themeLabel} onClick={() => setMode((m) => (m === 'dark' ? 'light' : 'dark'))}>
      {label}
    </button>
  )
}
