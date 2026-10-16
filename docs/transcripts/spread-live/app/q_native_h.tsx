import { useState } from 'react'
import FwdNative from './FwdNative'
export default function P() {
  const [w, setW] = useState(10)
  return <div><button onClick={() => setW(w + 1)}>grow</button><FwdNative onClick={() => setW(w + 1)} /></div>
}
