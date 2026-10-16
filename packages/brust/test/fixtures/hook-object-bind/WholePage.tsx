import { useCount, usePairOf, useToggle } from './Hooks'

export default function WholePage() {
  const t = useToggle()
  const c = useCount(2)
  const p = usePairOf()
  return (
    <main>
      <button type="button" data-testid="tog" onClick={t.toggle}>{t.on ? 'on' : 'off'}</button>
      <button type="button" data-testid="cnt" onClick={c.bump}>{c.label}:{c.n}</button>
      <button type="button" data-testid="pair" onClick={p[1]}>{p[0] ? 'yes' : 'no'}</button>
    </main>
  )
}
