import { useState } from 'react'
export default function P() {
  const [on, setOn] = useState(false)
  const toggle = () => setOn(!on)
  const o = { inner: { cb: toggle } }
  return <button type="button" onClick={o.inner.cb}>{on ? 'on' : 'off'}</button>
}
