import { useState } from 'react'
import Fwd from './Fwd'
export default function P() {
  const [w, setW] = useState(10)
  return <div><button onClick={() => setW(w + 1)}>grow</button><Fwd data-w={w} onClick={() => setW(w + 2)} /></div>
}
