import { useState } from 'react'
import FwdStyleAfter from './FwdStyleAfter'
export default function P() {
  const [w, setW] = useState(10)
  return <div><button onClick={() => setW(w + 1)}>grow</button><FwdStyleAfter style={{ width: w }} /></div>
}
