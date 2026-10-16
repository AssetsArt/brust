import { useState } from 'react'
export default function P() {
  const [on, setOn] = useState(false)
  const toggle = () => setOn(!on)
  const o = { cb: toggle, twice: [toggle, toggle].length }
  return <button type="button" onClick={o.cb}>{o.twice}{on ? 'on' : 'off'}</button>
}
