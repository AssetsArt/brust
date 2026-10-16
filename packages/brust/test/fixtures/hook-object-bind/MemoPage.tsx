import { useMemoToggle, useSpread } from './Hooks'

// A returned useMemo / a returned spread is not an object literal: the page stays React, and is served (was a 500).
export default function MemoPage() {
  const m = useMemoToggle()
  const s = useSpread({ label: 'x' })
  return (
    <main>
      <button type="button" data-testid="memo" onClick={m.toggle}>{m.on ? 'on' : 'off'}</button>
      <button type="button" data-testid="spread" onClick={s.toggle}>{s.label}{s.on ? 'on' : 'off'}</button>
    </main>
  )
}
