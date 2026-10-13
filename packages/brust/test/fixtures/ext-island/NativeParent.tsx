import { useState } from 'react'
import { Heart } from 'tiny-icons'

export default function NativeParent() {
  const [n, setN] = useState(0)
  return (
    <div>
      <button onClick={() => setN(n + 1)}>{n}</button>
      <Heart size={20} />
    </div>
  )
}
