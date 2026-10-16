import { useState } from 'react'
export default function P() {
  const [on, setOn] = useState(false)
  const toggle = () => setOn(!on)
  function reset() { setOn(false) }
  const o = { cb: toggle, off: reset, label: 'go' }
  return (
    <div>
      <button type="button" onClick={o.cb}>{o.label}</button>
      <button type="button" onClick={o.off}>reset</button>
      <button type="button" onClick={o.cb}>again</button>
      <p>{on ? 'on' : 'off'}</p>
    </div>
  )
}
