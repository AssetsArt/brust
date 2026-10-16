import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = React.useCallback(() => setOn((o) => !o), [])
  return { on, toggle }
}
function Kid(p: { t: { on: boolean } }) { return <i>{String(p.t.on)}</i> }
export default function P() {
  const t = useToggle()
  return <div><Kid t={t} /><button type="button" onClick={t.toggle}>x</button></div>
}
