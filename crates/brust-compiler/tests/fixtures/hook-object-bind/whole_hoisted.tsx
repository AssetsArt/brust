import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  return { on, toggle: React.useCallback(() => setOn((o) => !o), []) }
}
export default function P() {
  const t = useToggle()
  return <button type="button" onClick={t.toggle}>{t.on ? 'on' : 'off'}</button>
}
