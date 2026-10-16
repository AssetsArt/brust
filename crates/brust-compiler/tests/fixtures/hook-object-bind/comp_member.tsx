import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = React.useCallback(() => setOn((o) => !o), [])
  return { on, toggle }
}
export default function P() {
  const t = useToggle()
  const o = { cb: t.toggle }
  return <button type="button" onClick={o.cb}>{t.on ? 'on' : 'off'}</button>
}
