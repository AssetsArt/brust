import { useState } from 'react'
import b from './btn.module.css'

export default function Native() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="btn" className={n > 0 ? b.on : b.off} onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}
