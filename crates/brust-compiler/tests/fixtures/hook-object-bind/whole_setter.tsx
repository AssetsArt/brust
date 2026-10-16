import * as React from 'react'
function useFlag() {
  const [on, setOn] = React.useState(false)
  return { on, setOn }
}
export default function P() {
  const t = useFlag()
  return <button type="button" onClick={() => t.setOn(!t.on)}>{t.on ? 'on' : 'off'}</button>
}
