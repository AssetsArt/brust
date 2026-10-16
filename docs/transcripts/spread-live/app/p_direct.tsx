import { useState } from 'react'
export default function P() {
  const [w, setW] = useState(10)
  return <div><button onClick={() => setW(w + 1)}>grow</button><input type="checkbox" style={{ width: w, position: 'absolute' }} /></div>
}
