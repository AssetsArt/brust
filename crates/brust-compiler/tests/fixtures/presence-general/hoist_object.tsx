import * as React from 'react'
function useToggle() {
  const [on, setOn] = React.useState(false)
  return { on, toggle: React.useCallback(() => setOn((o) => !o), []), shout: React.useMemo(() => 'hi', []) }
}
export default function P() {
  const { on, toggle, shout } = useToggle()
  return <button type="button" onClick={toggle}>{shout}:{on ? 'on' : 'off'}</button>
}
