import { Heart } from 'lucide-react'
import { useState } from 'react'

export default function NativeIcon() {
  const [n, setN] = useState(16)
  const [c, setC] = useState('red')
  return (
    <div>
      <button id="grow" onClick={() => setN(n + 8)}>
        grow
      </button>
      <button id="paint" onClick={() => setC('blue')}>
        paint
      </button>
      <Heart size={n} color={c} />
    </div>
  )
}
