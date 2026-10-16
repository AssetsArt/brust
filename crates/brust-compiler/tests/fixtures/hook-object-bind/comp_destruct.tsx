import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = React.useCallback(() => setOn((o) => !o), [])
  return { on, toggle }
}
export default function P() {
  const { on, toggle } = useToggle()
  const o = { cb: toggle }
  return <button type="button" onClick={o.cb}>{on ? 'on' : 'off'}</button>
}
