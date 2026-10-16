import { useToggle } from './Hooks'

export default function CompDestructPage() {
  const { on, toggle } = useToggle()
  const o = { cb: toggle }
  return (
    <main>
      <button type="button" data-testid="compd" onClick={o.cb}>{on ? 'on' : 'off'}</button>
    </main>
  )
}
