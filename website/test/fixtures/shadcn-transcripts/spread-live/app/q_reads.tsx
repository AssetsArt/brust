import { useState } from 'react'
import FwdReads from './FwdReads'
export default function P() {
  const [w, setW] = useState(10)
  return <div><button onClick={() => setW(w + 1)}>grow</button><FwdReads style={{ width: w }} /></div>
}
