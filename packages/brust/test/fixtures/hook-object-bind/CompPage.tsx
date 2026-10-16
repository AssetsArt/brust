import { useToggle } from './Hooks'

// F331: `{ cb: t.toggle }` is read member by member (`o.cb` is `t.toggle`); it was a per-request job naming a handler (a 500).
export default function CompPage() {
  const t = useToggle()
  const o = { cb: t.toggle }
  return (
    <main>
      <button type="button" data-testid="comp" onClick={o.cb}>{t.on ? 'on' : 'off'}</button>
    </main>
  )
}
