import { useToggle } from './Hooks'

export default function DestructuredPage() {
  const { on, toggle } = useToggle()
  return (
    <main>
      <button type="button" data-testid="tog" onClick={toggle}>{on ? 'on' : 'off'}</button>
    </main>
  )
}
