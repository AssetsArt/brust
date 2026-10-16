import { useToggle } from './Hooks'

// A value the component computes from a handler (`{ cb: toggle }`) is a per-request job that cannot name it (was a 500):
// the page stays React and is served.
export default function CompPage() {
  const t = useToggle()
  const o = { cb: t.toggle }
  return (
    <main>
      <button type="button" data-testid="comp" onClick={o.cb}>{t.on ? 'on' : 'off'}</button>
    </main>
  )
}
