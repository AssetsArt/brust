import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  return { on, make: () => React.useCallback(() => setOn((o) => !o), []) }
}
export default function P() {
  const { on, make } = useToggle()
  return <button type="button" onClick={make()}>{on ? 'on' : 'off'}</button>
}
