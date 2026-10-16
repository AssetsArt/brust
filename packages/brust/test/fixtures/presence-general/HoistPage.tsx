import { usePair, useToggle } from './Hoist'

export default function HoistPage() {
  const [n, setN] = usePair(1)
  const { on, toggle, label } = useToggle()
  return (
    <main>
      <button type="button" data-testid="inc" onClick={() => setN(n + 1)}>{n}</button>
      <button type="button" data-testid="tog" onClick={toggle}>{label}:{on ? 'on' : 'off'}</button>
    </main>
  )
}
