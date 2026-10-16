import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = () => setOn(!on)
  return { on, toggle }
}
export default function P() {
  const t = useToggle()
  const k = 'toggle'
  return <button type="button" onClick={t[k]}>{t.on ? 'on' : 'off'}</button>
}
