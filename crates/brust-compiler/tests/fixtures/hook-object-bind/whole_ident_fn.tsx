import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = () => setOn(!on)
  const obj = { on, toggle }
  return obj
}
export default function P() {
  const t = useToggle()
  return <button type="button" onClick={t.toggle}>{t.on ? 'on' : 'off'}</button>
}
