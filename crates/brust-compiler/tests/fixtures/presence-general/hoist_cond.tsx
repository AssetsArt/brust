import * as React from 'react'
function useToggle(flag: boolean) {
  const [on, setOn] = React.useState(false)
  return { on, toggle: flag ? React.useCallback(() => setOn((o) => !o), []) : undefined }
}
export default function P() {
  const { on, toggle } = useToggle(true)
  return <button type="button" onClick={toggle}>{on ? 'on' : 'off'}</button>
}
