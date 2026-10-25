import { useState } from 'react'
import FwdOwnStyle from './FwdOwnStyle'
export default function P() {
  const [w, setW] = useState(10)
  return <div><button onClick={() => setW(w + 1)}>grow</button><FwdOwnStyle style={{ width: w }} /></div>
}
