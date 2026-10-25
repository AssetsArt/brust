import { useState } from 'react'
import FwdTwo from './FwdTwo'
export default function P() {
  const [w, setW] = useState(10)
  return <div><button onClick={() => setW(w + 1)}>grow</button><FwdTwo data-w={w} /></div>
}
