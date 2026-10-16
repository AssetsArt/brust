import * as React from 'react'
function useToggle(extra: { label: string }) {
  const [on, setOn] = React.useState(false)
  const toggle = React.useCallback(() => setOn((o) => !o), [])
  return { ...extra, on, toggle }
}
export default function P(p: { label: string }) {
  const t = useToggle(p)
  return <button type="button" onClick={t.toggle}>{t.label}{t.on ? 'on' : 'off'}</button>
}
