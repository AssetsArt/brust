import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = () => setOn((o) => !o)
  return [on, toggle]
}
export default function P() {
  const t = useToggle()
  return <button type="button" onClick={t[1]}>{t[0] ? 'on' : 'off'}</button>
}
