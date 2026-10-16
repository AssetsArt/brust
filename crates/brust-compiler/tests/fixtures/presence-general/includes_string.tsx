import { useState } from 'react'
export default function P() {
  const [s, setS] = useState('abc')
  return <button type="button" onClick={() => setS('b')} data-hit={'abc'.includes(s) ? 'y' : 'n'}>{s}</button>
}
